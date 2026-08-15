import type { Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import path from "node:path";
import { inspectWiki } from "./inspect.js";
import { createPiLeadRuntime } from "./lead-runtime.js";
import { createWikiPublicationStore } from "./publication-store.js";
import { createWikiRunSpecStore } from "./run-spec-store.js";
import { WikiProducer } from "./producer.js";
import type { WikiLeadRuntime, WikiPreparedRun, WikiProducerAdapters } from "./producer-types.js";
import { wikiRoleBrief } from "./skill-briefs.js";
import { materializeProductionSkill, skillWorkspacePath } from "./skill-store.js";
import { finalizeWiki } from "./wiki-finalize.js";
import type { WikiSpec } from "./wiki-spec.js";
import { ensureWikiWorkspaceInternalIgnore, loadWikiWorkspace, type WikiGenerationProfile } from "./workspace.js";

interface ProductionWikiProducerOptions {
  getModel?: () => Model<any> | undefined;
  getThinkingLevel?: () => ThinkingLevel | undefined;
  /** @internal Deterministic production-seam injection for integration tests. */
  createLead?: (prepared: WikiPreparedRun) => WikiLeadRuntime;
}

/** Stable public factory. Host/model injection stays package-internal. */
export function createProductionWikiProducer(): WikiProducer {
  return createConfiguredWikiProducer({});
}

/** @internal Used by the Pi host and production seam tests; not exported by index.ts. */
export function createConfiguredWikiProducer(options: ProductionWikiProducerOptions): WikiProducer {
  const stores = new Map<string, ReturnType<typeof createWikiPublicationStore>>();
  const publicationStore = (cwd: string) => {
    let store = stores.get(cwd);
    if (!store) {
      store = createWikiPublicationStore({ workspace: cwd });
      stores.set(cwd, store);
    }
    return store;
  };

  const adapters: WikiProducerAdapters = {
    async prepare(input) {
      const workspace = await loadWikiWorkspace(input.cwd);
      const store = publicationStore(workspace.root);
      await store.recoverPending();
      await ensureWikiWorkspaceInternalIgnore(workspace.root);
      const inspection = await inspectWiki(input.cwd);
      const mode = input.operation === "regenerate" ? "generate" : inspection.mode;
      const published = input.operation === "update" ? await store.readPublishedMetadata() : undefined;
      if (input.operation === "update" && mode === "refresh" && !published?.wikiSpec) {
        throw new Error("Incremental Wiki update requires a validated published WikiSpec; use regenerate to establish the new topology");
      }
      const candidateWikiRoot = input.preparation === "resume"
        ? await store.ensureCandidate(input.runId, mode)
        : await store.prepareCandidate(input.runId, mode);
      const skillRoot = await materializeProductionSkill(workspace.root, input.runId);
      return {
        inspection,
        sourceFingerprint: inspection.sourceFingerprint,
        candidateWikiRoot,
        skillRoot,
        sourceScopeIds: inspection.sourcePaths,
        language: workspace.language,
        generation: workspace.wiki.generation,
        ...(published?.wikiSpec ? { priorWikiSpec: published.wikiSpec } : {}),
        maxConcurrentAgents: workspace.wiki.maxConcurrentAgents,
        transientRetries: workspace.wiki.transientRetries,
        baseRetryDelayMs: workspace.wiki.baseRetryDelayMs,
        sessionTimeoutMs: workspace.wiki.sessionTimeoutSeconds * 1_000,
        prompt: leadPrompt(input.operation, input.focus, inspection, candidateWikiRoot, skillRoot, input.runId, workspace.language, workspace.wiki.generation, published?.wikiSpec),
      };
    },
    createLead(prepared) {
      return options.createLead?.(prepared) ?? createPiLeadRuntime({
        model: options.getModel?.(),
        thinkingLevel: options.getThinkingLevel?.(),
        language: prepared.language,
        concurrency: prepared.maxConcurrentAgents - 1,
        transientRetries: prepared.transientRetries,
        baseRetryDelayMs: prepared.baseRetryDelayMs,
        sessionTimeoutMs: prepared.sessionTimeoutMs,
      });
    },
    async validate(input) {
      if (input.leadOutcome.kind !== "complete") throw new Error(`Wiki Lead paused: ${input.leadOutcome.summary}`);
      const root = inspectionRoot(input.inspection);
      const candidateDirectory = workspaceRelative(root, input.candidateWikiRoot);
      const record = await createWikiRunSpecStore({ workspace: root }).read(input.runId);
      if (!record) throw new Error("Wiki Lead completed without a persisted WikiSpec");
      const finalized = await finalizeWiki(root, record.spec, candidateDirectory, undefined, input.generation.templates.requiredSections);
      return { ok: true as const, pages: finalized.pages, wikiSpec: record.spec };
    },
    async publish(input) {
      const validation = acceptedValidation(input.validation);
      const current = await inspectWiki(input.cwd);
      if (current.sourceFingerprint !== input.sourceFingerprint) {
        throw new Error("Repository sources changed during Wiki production; start a new update run");
      }
      await publicationStore(current.root).publish(input.runId, {
        operation: input.operation,
        pages: validation.pages,
        sourceFingerprint: current.sourceFingerprint,
        summary: input.leadOutcome.summary,
        wikiSpec: validation.wikiSpec,
      });
      return { pages: validation.pages, sourceFingerprint: current.sourceFingerprint };
    },
  };
  return new WikiProducer({ adapters });
}

function inspectionRoot(value: unknown): string {
  if (!value || typeof value !== "object" || typeof (value as { root?: unknown }).root !== "string") {
    throw new Error("Wiki inspection has no workspace root");
  }
  return (value as { root: string }).root;
}

function acceptedValidation(value: unknown): { ok: true; pages: string[]; wikiSpec: WikiSpec } {
  if (!value || typeof value !== "object") throw new Error("Wiki candidate validation is unavailable");
  const candidate = value as { ok?: unknown; pages?: unknown };
  const withSpec = candidate as typeof candidate & { wikiSpec?: unknown };
  if (candidate.ok !== true || !Array.isArray(candidate.pages) || candidate.pages.some((page) => typeof page !== "string") || !withSpec.wikiSpec) {
    throw new Error("Wiki candidate did not pass validation");
  }
  return candidate as { ok: true; pages: string[]; wikiSpec: WikiSpec };
}

function workspaceRelative(workspace: string, candidateWikiRoot: string): string {
  const relative = path.relative(path.resolve(workspace), path.resolve(candidateWikiRoot));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Candidate Wiki directory must be inside the workspace");
  }
  return relative.split(path.sep).join("/");
}

function leadPrompt(
  operation: string,
  focus: string | undefined,
  inspection: WikiPreparedRun["inspection"],
  candidateWikiRoot: string,
  skillRoot: string,
  runId: string,
  language: "zh" | "en",
  generation: WikiGenerationProfile,
  priorWikiSpec?: WikiSpec,
): string {
  const sourcePaths = inspection && typeof inspection === "object" && Array.isArray((inspection as { sourcePaths?: unknown }).sourcePaths)
    ? (inspection as { sourcePaths: unknown[] }).sourcePaths.filter((value): value is string => typeof value === "string")
    : [];
  const skillDirectory = skillWorkspacePath(runId);
  return [
    `Produce a source-grounded repository Wiki using the ${operation} operation.`,
    focus ? `Prioritize this focus without omitting essential context: ${focus}` : "",
    `Declared source scopes: ${JSON.stringify(sourcePaths)}.`,
    `Candidate Wiki directory: ${candidateWikiRoot}.`,
    `Production skill directory: ${skillDirectory}.`,
    "When writing a page directly, read the matching template under that directory first.",
    language === "zh"
      ? "Write all reader-facing Wiki content, including titles and page body / prose, in Simplified Chinese. Keep code identifiers and source citations unchanged."
      : "Write all reader-facing Wiki content, including titles and page body / prose, in English. Keep code identifiers and source citations unchanged.",
    `Generation profile: ${JSON.stringify(generation)}. Treat it as reader intent, never as source evidence.`,
    priorWikiSpec ? `Prior published WikiSpec for incremental planning: ${JSON.stringify(priorWikiSpec)}.` : "",
    "First submit a complete version:1 WikiSpec using wiki_plan. No candidate page may be written before it is accepted.",
    "WikiSpec is the versioned page topology; written pages use YAML type/title/description/sources.",
    "Use one top-level directory per domain with domain.md and evidence-driven concepts/, flows/, states/, data/, or modules/ child pages. Flow pages own sequence diagrams.",
    "Dynamically inspect coverage, delegate bounded research/write/review tasks, and continue only where evidence is missing.",
    "Direct Lead writing is available only for one-domain plans of at most three content pages and is permanently disabled after compaction; otherwise delegate exact-path writers.",
    "Use artifact handles for delegated results. Treat failed branches as missing coverage, never as evidence of absence.",
    "Delegate independent exact-path reviewers after writing. Reviewers must call wiki_review_finish; call wiki_finish only after every current Spec page has a passing current-revision review.",
    wikiRoleBrief(skillRoot, "lead"),
  ].filter(Boolean).join("\n");
}
