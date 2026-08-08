import { createWorkflowStorage, type SavedWorkflow, type WorkflowStorage } from "@quintinshaw/pi-dynamic-workflows";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstalledWikiWorkflow {
  name: "wiki-generate" | "wiki-refresh";
  path: string;
}

export interface WorkflowInstallResult {
  cwd: string;
  workflows: InstalledWikiWorkflow[];
}

const PLAN_SCHEMA = `{
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          purpose: { type: "string" },
          sources: { type: "array", items: { type: "string" } }
        },
        required: ["path", "title", "purpose", "sources"]
      }
    },
    researchScopes: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { id: { type: "string" }, task: { type: "string" } },
        required: ["id", "task"]
      }
    },
    rationale: { type: "string" }
  },
  required: ["pages", "researchScopes", "rationale"]
}`;

const WRITE_SCHEMA = `{
  type: "object",
  properties: {
    updatedPages: { type: "array", items: { type: "string" } },
    deletedPages: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  },
  required: ["updatedPages", "deletedPages", "notes"]
}`;

const REVIEW_SCHEMA = `{
  type: "object",
  properties: {
    defects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          page: { type: "string" },
          kind: { type: "string", enum: ["evidence", "link", "format", "topology", "coverage"] },
          detail: { type: "string" }
        },
        required: ["id", "page", "kind", "detail"]
      }
    },
    summary: { type: "string" }
  },
  required: ["defects", "summary"]
}`;

const FINALIZE_SCHEMA = `{
  type: "object",
  properties: {
    exitCode: { type: "integer", minimum: 0 },
    validation: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        errors: { type: "array", items: { type: "string" } },
        pages: { type: "array", items: { type: "string" } }
      },
      required: ["ok", "errors", "pages"]
    }
  },
  required: ["exitCode", "validation"]
}`;

function workflowScript(mode: "generate" | "refresh", wikiCli = "okf-wiki"): string {
  const command = mode === "generate" ? "wiki-generate" : "wiki-refresh";
  const modeInstruction = mode === "generate"
    ? "Create a complete Wiki for this repository."
    : "Refresh the Wiki using the Git impact analysis; when inspect reports a full rebuild, treat it as a complete Wiki generation.";

  return `export const meta = {
  name: "${command.replace("-", "_")}",
  description: "${mode === "generate" ? "Generate a Git-native repository Wiki" : "Refresh a Git-native repository Wiki from Git changes"}",
  phases: [
    { title: "Plan" },
    { title: "Research" },
    { title: "Write" },
    { title: "Review" },
    { title: "Repair" },
    { title: "Replan" },
    { title: "Finalize" }
  ]
};

const invocation = args && typeof args === "object" ? args : {};
const language = invocation.lang === "en" ? "en" : "zh";
const focus = typeof invocation._raw === "string" ? invocation._raw : "";
const plannerSchema = ${PLAN_SCHEMA};
const writeSchema = ${WRITE_SCHEMA};
const reviewSchema = ${REVIEW_SCHEMA};
const finalizeSchema = ${FINALIZE_SCHEMA};

function boundedScopes(plan) {
  if (!plan || !Array.isArray(plan.researchScopes)) return [];
  const scopes = [];
  const ids = new Set();
  for (const scope of plan.researchScopes) {
    if (!scope || typeof scope.id !== "string" || typeof scope.task !== "string" || ids.has(scope.id)) continue;
    ids.add(scope.id);
    scopes.push({ id: scope.id, task: scope.task });
    if (scopes.length === 4) break;
  }
  return scopes;
}

phase("Plan");
const initialPlan = await agent(
  "You are the Wiki planner. Work directly in the current Git workspace. Run \`${wikiCli} inspect --json\` first and use its result as the authoritative change scope. ${modeInstruction} Do not create snapshots, source registries, manifests, or run state. Plan only pages under \`wiki/\`; all planned source references must be workspace-relative and include a line range, for example \`src/foo.ts#L12-L30\`. Return up to four research scopes only when independent repository areas need more evidence. Language: " + language + ". Focus: " + focus,
  { label: "plan:initial", schema: plannerSchema, retries: 1 }
);

if (initialPlan === null) {
  return { ok: false, stage: "plan", reason: "planner returned no result" };
}

let activePlan = initialPlan;
let researchLedger = [];
const scopes = boundedScopes(activePlan);
if (scopes.length > 0) {
  phase("Research");
  const research = await parallel(
    scopes.map((scope, index) => () => agent(
      "Read only the current workspace. Research this bounded Wiki evidence scope: " + scope.task + ". Return concrete workspace-relative source paths and concise implementation facts. Do not edit files and do not run nested agents.",
      { label: "research:" + (index + 1) + ":" + scope.id, retries: 1 }
    ))
  );
  researchLedger = scopes.map((scope, index) => ({
    id: scope.id,
    status: research[index] === null ? "missing" : "complete",
    result: research[index]
  }));
}

phase("Write");
let writeResult = await agent(
  "You are the only Wiki writer. Work directly in the current Git workspace. Write the requested Wiki pages under \`wiki/\` and remove generated pages that no longer belong to the plan. ${modeInstruction} Use YAML frontmatter with type, title, description, and sources. Every frontmatter source must be workspace-relative and include a #Lstart-Lend range, for example \`src/foo.ts#L12-L30\`. In Markdown body, make source citations as \`[label](repo:src/foo.ts#L12-L30)\`; do not use bare code paths as Markdown links. Do not edit files outside \`wiki/\`, do not add metadata/state files, and do not create snapshots. Plan: " + JSON.stringify(activePlan) + ". Research ledger: " + JSON.stringify(researchLedger) + ". Language: " + language,
  { label: "write:initial", schema: writeSchema, retries: 1 }
);

if (writeResult === null) {
  return { ok: false, stage: "write", reason: "writer returned no result", research: researchLedger };
}

const reviewLedger = [];
let passedReview = false;
for (let round = 1; round <= 2; round++) {
  phase("Review");
  const review = await agent(
    "Review the current \`wiki/\` against the current workspace and the generator contract. Verify source evidence, mandatory line ranges, navigation, and whether important repository concepts are covered. Frontmatter sources must be bare workspace-relative paths with #Lstart-Lend; body source citations must be Markdown links of the form \`[label](repo:src/foo.ts#L12-L30)\`. Return every actionable defect with kind evidence, link, format, topology, or coverage. Only topology and coverage justify replanning; all other kinds are local repairs. Do not edit files.",
    { label: "review:" + round, schema: reviewSchema, retries: 1 }
  );
  if (review === null) {
    reviewLedger.push({ round, status: "missing", defects: [] });
    return { ok: false, stage: "review", reason: "reviewer returned no result", research: researchLedger, reviews: reviewLedger };
  }

  reviewLedger.push({ round, status: "complete", defects: review.defects });
  if (review.defects.length === 0) {
    passedReview = true;
    break;
  }
  if (round === 2) {
    return { ok: false, stage: "review", reason: "defects remain after the bounded repair loop", research: researchLedger, reviews: reviewLedger };
  }

  const structural = review.defects.filter((defect) => defect.kind === "topology" || defect.kind === "coverage");
  if (structural.length > 0) {
    phase("Replan");
    const revised = await agent(
      "Replan only because the review found topology or coverage defects. Work directly in the current workspace. Do not invent a source layer or snapshot. Preserve valid pages and return a revised page plan that resolves these defects: " + JSON.stringify(structural) + ". Current plan: " + JSON.stringify(activePlan),
      { label: "replan:1", schema: plannerSchema, retries: 1 }
    );
    if (revised === null) {
      return { ok: false, stage: "replan", reason: "replanner returned no result", research: researchLedger, reviews: reviewLedger };
    }
    activePlan = revised;
  } else {
    phase("Repair");
  }

  const repairLabel = structural.length > 0 ? "write:replanned" : "repair:local";
  writeResult = await agent(
    "You are the only Wiki writer. Correct the current \`wiki/\` directly. Do not edit files outside \`wiki/\` and do not create snapshots or state files. " + (structural.length > 0 ? "Use this revised plan: " + JSON.stringify(activePlan) : "Apply these local defects without changing page topology: " + JSON.stringify(review.defects)) + ". Keep every frontmatter citation workspace-relative with a #Lstart-Lend range. In Markdown body, use source links only as \`[label](repo:src/foo.ts#L12-L30)\`. Re-read the current source code before correcting it. Language: " + language,
    { label: repairLabel, schema: writeSchema, retries: 1 }
  );
  if (writeResult === null) {
    return { ok: false, stage: "repair", reason: "writer returned no result", research: researchLedger, reviews: reviewLedger };
  }
}

if (!passedReview) {
  return { ok: false, stage: "review", reason: "review did not pass", research: researchLedger, reviews: reviewLedger };
}

phase("Finalize");
const finalization = await gate(
  async (feedback, attempt) => await agent(
    "You are the finalizer. Do not edit files yourself. Run exactly \`${wikiCli} finalize --json\` in the current workspace using the shell; its generated Wiki index updates are the only permitted write. Return its exact process exitCode and the complete JSON object printed on stdout as validation. If stdout is not valid JSON, return validation { ok: false, errors: [the command stderr], pages: [] }. Never claim success without command output. The command alone rebuilds generated Wiki indexes and validates frontmatter, citations, links, and Mermaid. " + (feedback ? "The prior command failed with: " + feedback : "") + " Do not create snapshots, source folders, manifests, or run state.",
    { label: "finalize:" + (attempt + 1), schema: finalizeSchema, retries: 1 }
  ),
  (value) => {
    if (value !== null && value.exitCode === 0 && value.validation && value.validation.ok === true) return { ok: true };
    const errors = value && value.validation && Array.isArray(value.validation.errors)
      ? value.validation.errors
      : ["finalizer did not return a successful okf-wiki finalize result"];
    return { ok: false, feedback: errors.join("\\n") };
  },
  { attempts: 2 }
);

return {
  ok: finalization.ok,
  mode: "${mode}",
  plan: activePlan,
  research: researchLedger,
  write: writeResult,
  reviews: reviewLedger,
  finalization: finalization.value
};`;
}

export const WIKI_GENERATE_WORKFLOW = workflowScript("generate");
export const WIKI_REFRESH_WORKFLOW = workflowScript("refresh");

export const WIKI_WORKFLOW_DEFINITIONS: ReadonlyArray<Pick<SavedWorkflow, "name" | "description" | "script" | "parameters">> = [
  {
    name: "wiki-generate",
    description: "Generate a Git-native repository Wiki in wiki/",
    script: WIKI_GENERATE_WORKFLOW,
    parameters: {
      lang: { type: "string", description: "Wiki language: zh or en", default: "zh" },
    },
  },
  {
    name: "wiki-refresh",
    description: "Refresh a Git-native repository Wiki from Git changes",
    script: WIKI_REFRESH_WORKFLOW,
    parameters: {
      lang: { type: "string", description: "Wiki language: zh or en", default: "zh" },
    },
  },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function installedCliCommand(): string {
  const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [process.execPath, path.join(packageDirectory, "cli.js")].map(shellQuote).join(" ");
}

export function installWikiWorkflows(cwd: string, storage: Pick<WorkflowStorage, "save"> = createWorkflowStorage(cwd)): WorkflowInstallResult {
  const wikiCli = installedCliCommand();
  const workflows = WIKI_WORKFLOW_DEFINITIONS.map((workflow) => {
    const mode = workflow.name === "wiki-generate" ? "generate" : "refresh";
    const saved = storage.save({ ...workflow, script: workflowScript(mode, wikiCli), location: "project" });
    return { name: saved.name as InstalledWikiWorkflow["name"], path: saved.path };
  });
  return { cwd, workflows };
}
