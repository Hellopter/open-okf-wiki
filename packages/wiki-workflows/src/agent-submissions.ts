import { Buffer } from "node:buffer";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  SubmissionFailure,
  SubmissionFailureCode,
  SubmissionIssue,
  SubmissionToolName,
} from "./agent-errors.js";
import type { WorkspaceToolPolicy } from "./path-policy.js";
import {
  MAX_CONTROL_ARTIFACT_BYTES,
  MAX_RESEARCH_ARTIFACT_BYTES,
  parseResearchSubmission,
  parseReviewSubmission,
  parseSynthesisSubmission,
  researchFinalizeSubmissionSchema,
  researchFindingSchema,
  reviewDefectSchema,
  reviewFinalizeSubmissionSchema,
  wikiSpecCoordinationSchema,
  wikiSpecDomainSchema,
  WikiControlSubmissionSizeError,
} from "./control-submissions.js";
import { loadResearchSourceRoots, validateResearchArtifact } from "./research-evidence.js";
import { submissionContractGuidance } from "./submissions/contracts.js";
import type {
  WikiAgentExecutionRequest,
  WikiControlSubmission,
  WikiSpec,
  WikiResearchCatalogScope,
} from "./workflow-types.js";

export type { SubmissionToolName, SubmissionFailure, SubmissionFailureCode, SubmissionIssue };
export { submissionContractGuidance };

/** Upper bound for configurable in-context submission opportunities. */
export const MAX_SUBMISSIONS_PER_ATTEMPT = 3;
export const MAX_STAGING_MUTATIONS = 128;
export const MAX_RESEARCH_FINDINGS_PER_BATCH = 20;
export const MAX_QUERY_RESULT_BYTES = 24 * 1024;

export interface SubmissionCollector {
  toolNames: readonly SubmissionToolName[];
  acceptedToolName?: SubmissionToolName;
  pagePath?: string;
  value?: unknown;
  failure?: SubmissionFailure;
  submissionAttempts: number;
  maxSubmissions: number;
  exhausted?: boolean;
  pendingAttempt?: Promise<void>;
  mutationCount: number;
  research?: { findings: Map<string, unknown> };
  review?: { defects: Map<string, unknown> };
  plan?: {
    domains: Map<string, unknown>;
    coordination: { crossLinks: unknown[]; sharedTerms: unknown[]; omissions: unknown[] };
  };
  validate?: (submission: WikiControlSubmission) => void;
  validatePage?: WikiAgentExecutionRequest["validatePageSubmission"];
}

interface QueryLock {
  pendingAttempt?: Promise<void>;
}

export function submissionFor(request: WikiAgentExecutionRequest): SubmissionCollector | undefined {
  const maxSubmissions = request.maxSubmissionAttempts ?? MAX_SUBMISSIONS_PER_ATTEMPT;
  if (!Number.isInteger(maxSubmissions) || maxSubmissions < 1 || maxSubmissions > MAX_SUBMISSIONS_PER_ATTEMPT) {
    throw new Error(`Workflow configuration error: maxSubmissionAttempts must be an integer from 1 to ${MAX_SUBMISSIONS_PER_ATTEMPT}`);
  }
  const base = { submissionAttempts: 0, maxSubmissions, mutationCount: 0 };
  if (request.node.kind === "write") {
    if (!request.validatePageSubmission || request.writePaths?.length !== 1) {
      throw new Error("Workflow configuration error: writers require one page submission validator");
    }
    const pagePath = request.writePaths[0]!.replace(/^wiki\//, "");
    return { ...base, toolNames: ["wiki_submit_page"], pagePath, validatePage: request.validatePageSubmission };
  }
  if (request.node.kind === "research") return {
    ...base,
    toolNames: ["wiki_submit_research"],
    research: { findings: new Map() },
    validate: request.validateControlSubmission,
  };
  if (request.node.kind === "synthesis") {
    const collector: SubmissionCollector = {
      ...base,
      toolNames: ["wiki_submit_synthesis_finalize"],
      plan: { domains: new Map(), coordination: { crossLinks: [], sharedTerms: [], omissions: [] } },
      validate: request.validateControlSubmission,
    };
    if (request.initialSynthesisSpec) seedSynthesisPlan(collector, request.initialSynthesisSpec);
    return collector;
  }
  if (request.node.kind === "review") {
    return { ...base, toolNames: ["wiki_submit_review"], review: { defects: new Map() }, validate: request.validateControlSubmission };
  }
  return undefined;
}

/** Seed a structural replanning collector from the prior finalized WikiSpec. */
export function seedSynthesisPlan(submission: SubmissionCollector, spec: WikiSpec): void {
  if (!submission.plan) throw new Error("Only synthesis collectors accept a WikiSpec seed");
  const parsed = parseSynthesisSubmission({ spec, rationale: "Seed validation" });
  submission.plan.domains = new Map(parsed.spec.domains.map((domain) => [domain.id, structuredClone(domain)]));
  submission.plan.coordination = {
    crossLinks: structuredClone(parsed.spec.crossLinks),
    sharedTerms: structuredClone(parsed.spec.sharedTerms),
    omissions: structuredClone(parsed.spec.omissions),
  };
}

export interface SubmissionToolOptions {
  /** Scope-authorized source roots for research evidence validation. */
  allowedSourceRoots?: readonly string[];
}

export function submissionTools(
  policy: WorkspaceToolPolicy,
  submission: SubmissionCollector,
  options: SubmissionToolOptions = {},
): ToolDefinition<any, any, any>[] {
  const staging = submission.research ? researchStagingTools(policy, submission, options)
    : submission.plan ? planStagingTools(submission)
      : submission.review ? reviewStagingTools(submission)
      : [];
  return [...staging, ...submission.toolNames.map((toolName) => submissionTool(policy, submission, toolName, options))];
}

export function researchCatalogTools(catalog: readonly WikiResearchCatalogScope[]): ToolDefinition<any, any, any>[] {
  const findings = catalog.flatMap((scope) => scope.findings.map((finding) => ({ ...finding, scopeId: scope.scopeId })));
  const lock: QueryLock = {};
  return [
    queryTool("wiki_research_scopes", Type.Object({}, { additionalProperties: false }), lock, () => ({
      scopes: catalog.map((scope) => ({
        scopeId: scope.scopeId,
        task: scope.task,
        sourcePaths: scope.sourcePaths,
        findingCount: scope.findings.length,
      })),
    })),
    queryTool("wiki_research_findings", Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      scopeId: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }), lock, (params: { offset?: number; limit?: number; scopeId?: string }) => {
      const selected = params.scopeId ? findings.filter((finding) => finding.scopeId === params.scopeId) : findings;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      return { findings: selected.slice(offset, offset + limit), offset, total: selected.length, nextOffset: offset + limit < selected.length ? offset + limit : undefined };
    }),
  ];
}

function submissionTool(
  policy: WorkspaceToolPolicy,
  submission: SubmissionCollector,
  toolName: SubmissionToolName,
  options: SubmissionToolOptions,
): ToolDefinition<any, any, any> {
  if (toolName === "wiki_submit_page") return pageSubmissionTool(submission);

  const parser = toolName === "wiki_submit_research" ? (value: unknown) => parseResearchSubmission({ ...(value as object), findings: [...(submission.research?.findings.values() ?? [])] })
    : toolName === "wiki_submit_synthesis_finalize" ? (value: unknown) => parseSynthesisSubmission({ ...(value as object), spec: stagedSpec(submission) })
      : (value: unknown) => parseReviewSubmission({ ...(value as object), defects: [...(submission.review?.defects.values() ?? [])] });
  const parameters = toolName === "wiki_submit_research" ? researchFinalizeSubmissionSchema
    : toolName === "wiki_submit_synthesis_finalize" ? Type.Object({ rationale: Type.String({ minLength: 1 }) }, { additionalProperties: false })
      : reviewFinalizeSubmissionSchema;
  const role = toolName === "wiki_submit_research" ? "research result"
    : toolName === "wiki_submit_synthesis_finalize" ? "final Wiki plan"
      : "semantic review";
  const terminalInstructions = toolName === "wiki_submit_research"
    ? "Submit only the final summary and gaps; staged findings are assembled automatically."
    : toolName === "wiki_submit_synthesis_finalize"
      ? "Submit only the rationale; the staged WikiSpec is assembled automatically."
      : toolName === "wiki_submit_review"
          ? "Submit only the summary; staged defects are assembled automatically."
          : "Submit the complete typed result object directly.";

  return {
    name: toolName,
    label: toolName,
    description: `${terminalInstructions} ${submissionContractGuidance(toolName)}`,
    promptSnippet: `Submit the typed Wiki ${role}`,
    promptGuidelines: [
      `${terminalInstructions} If rejected and attempts remain, fix every returned issue and resubmit in this session. Stop after acceptance or when the tool reports that the budget is exhausted.`,
    ],
    parameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params) {
      const result = await attemptSubmission(submission, toolName, async () => {
        const parsed = parser(params) as WikiControlSubmission;
        if (toolName === "wiki_submit_research") {
          const allowedSourceRoots = options.allowedSourceRoots ?? [];
          validateResearchArtifact(parsed as ReturnType<typeof parseResearchSubmission>, {
            cwd: policy.workspaceRoot,
            allowedSourceRoots,
            sourceRoots: await loadResearchSourceRoots(policy.workspaceRoot, allowedSourceRoots),
          });
        }
        submission.validate?.(parsed);
        return parsed;
      });
      return submissionToolResult(result, `Wiki ${role} accepted.`);
    },
  };
}

function researchStagingTools(
  policy: WorkspaceToolPolicy,
  submission: SubmissionCollector,
  options: SubmissionToolOptions,
): ToolDefinition<any, any, any>[] {
  return [
    stagingTool("wiki_research_put_findings", Type.Object({
      findings: Type.Array(Type.Object({
        slot: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" }),
        finding: researchFindingSchema,
      }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_RESEARCH_FINDINGS_PER_BATCH }),
    }, { additionalProperties: false }), submission, async (params: { findings: Array<{ slot: string; finding: unknown }> }) => {
      if (params.findings.length > MAX_RESEARCH_FINDINGS_PER_BATCH) throw new Error(`Research batches may contain at most ${MAX_RESEARCH_FINDINGS_PER_BATCH} findings`);
      if (params.findings.some((entry) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(entry.slot))) throw new Error("Research finding slot is invalid");
      if (new Set(params.findings.map((entry) => entry.slot)).size !== params.findings.length) throw new Error("Research batch repeats a slot");
      const parsed = parseResearchSubmission({ summary: "Staged research findings", findings: params.findings.map((entry) => entry.finding), gaps: [] });
      const allowedSourceRoots = options.allowedSourceRoots ?? [];
      validateResearchArtifact(parsed, {
        cwd: policy.workspaceRoot,
        allowedSourceRoots,
        sourceRoots: await loadResearchSourceRoots(policy.workspaceRoot, allowedSourceRoots),
      });
      const next = new Map(submission.research!.findings);
      params.findings.forEach((entry, index) => next.set(entry.slot, parsed.findings[index]));
      const canonical = parseResearchSubmission({ summary: "Staged", findings: [...next.values()], gaps: [] });
      assertStagedSize(canonical, MAX_RESEARCH_ARTIFACT_BYTES, "Research staging");
      submission.research!.findings = next;
      return { stagedFindings: next.size };
    }),
    stagingTool("wiki_research_remove_finding", Type.Object({
      slot: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" }),
    }, { additionalProperties: false }), submission, (params: { slot: string }) => {
      const removed = submission.research!.findings.delete(params.slot);
      return { removed, stagedFindings: submission.research!.findings.size };
    }),
    queryTool("wiki_research_findings", Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESEARCH_FINDINGS_PER_BATCH })),
    }, { additionalProperties: false }), submission, (params: { offset?: number; limit?: number }) => {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? MAX_RESEARCH_FINDINGS_PER_BATCH;
      const findings = [...submission.research!.findings.entries()].map(([slot, finding]) => ({ slot, finding }));
      return { findings: findings.slice(offset, offset + limit), offset, total: findings.length, nextOffset: offset + limit < findings.length ? offset + limit : undefined };
    }),
    queryTool("wiki_research_scopes", Type.Object({}, { additionalProperties: false }), submission, () => ({
      scopes: [{ sourcePaths: options.allowedSourceRoots ?? [] }],
    })),
    queryTool("wiki_submission_status", Type.Object({}, { additionalProperties: false }), submission, () => ({
      findings: submission.research!.findings.size,
      mutations: submission.mutationCount,
      remainingMutations: MAX_STAGING_MUTATIONS - submission.mutationCount,
    })),
  ];
}

function planStagingTools(submission: SubmissionCollector): ToolDefinition<any, any, any>[] {
  return [
    stagingTool("wiki_plan_put_domain", Type.Object({ domain: wikiSpecDomainSchema }, { additionalProperties: false }), submission, (params: { domain: { id: string } }) => {
      if (!params.domain || typeof params.domain.id !== "string" || !params.domain.id.trim()) throw new Error("Plan domain must include a non-empty id");
      const domains = new Map(submission.plan!.domains);
      domains.set(params.domain.id.trim(), structuredClone(params.domain));
      assertStagedSize({ domains: [...domains.values()], ...submission.plan!.coordination }, MAX_CONTROL_ARTIFACT_BYTES, "Plan staging");
      submission.plan!.domains = domains;
      return { domains: domains.size };
    }),
    stagingTool("wiki_plan_remove_domain", Type.Object({ domainId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), submission, (params: { domainId: string }) => {
      const removed = submission.plan!.domains.delete(params.domainId.trim());
      return { removed, domains: submission.plan!.domains.size };
    }),
    stagingTool("wiki_plan_set_coordination", wikiSpecCoordinationSchema, submission, (params: { crossLinks?: unknown[]; sharedTerms?: unknown[]; omissions?: unknown[] }) => {
      const coordination = {
        crossLinks: structuredClone(params.crossLinks ?? []),
        sharedTerms: structuredClone(params.sharedTerms ?? []),
        omissions: structuredClone(params.omissions ?? []),
      };
      assertStagedSize({ domains: [...submission.plan!.domains.values()], ...coordination }, MAX_CONTROL_ARTIFACT_BYTES, "Plan staging");
      submission.plan!.coordination = coordination;
      return { domains: submission.plan!.domains.size, ...coordinationCounts(coordination) };
    }),
    queryTool("wiki_spec_get_domain", Type.Object({
      domainId: Type.String({ minLength: 1 }),
      pageOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      pageLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }), submission, (params: { domainId: string; pageOffset?: number; pageLimit?: number }) => {
      const domain = submission.plan!.domains.get(params.domainId) as { id?: unknown; title?: unknown; purpose?: unknown; pages?: unknown[] } | undefined;
      if (!domain) return { domain: undefined };
      const pageOffset = params.pageOffset ?? 0;
      const pageLimit = params.pageLimit ?? 10;
      const pages = Array.isArray(domain.pages) ? domain.pages : [];
      return {
        domain: { id: domain.id, title: domain.title, purpose: domain.purpose, pages: pages.slice(pageOffset, pageOffset + pageLimit) },
        pageOffset,
        pageCount: pages.length,
        nextOffset: pageOffset + pageLimit < pages.length ? pageOffset + pageLimit : undefined,
      };
    }),
    queryTool("wiki_submission_status", Type.Object({}, { additionalProperties: false }), submission, () => ({
      domains: [...submission.plan!.domains.keys()],
      ...coordinationCounts(submission.plan!.coordination),
      mutations: submission.mutationCount,
      remainingMutations: MAX_STAGING_MUTATIONS - submission.mutationCount,
    })),
  ];
}

function reviewStagingTools(submission: SubmissionCollector): ToolDefinition<any, any, any>[] {
  return [
    stagingTool("wiki_review_put_defects", Type.Object({
      defects: Type.Array(Type.Object({
        slot: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" }),
        defect: reviewDefectSchema,
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }), submission, (params: { defects: Array<{ slot: string; defect: unknown }> }) => {
      if (params.defects.length > 20) throw new Error("Review batches may contain at most 20 defects");
      if (params.defects.some((entry) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(entry.slot))) throw new Error("Review defect slot is invalid");
      if (new Set(params.defects.map((entry) => entry.slot)).size !== params.defects.length) throw new Error("Review batch repeats a slot");
      const parsed = parseReviewSubmission({ defects: params.defects.map((entry) => entry.defect), summary: "Staged review defects" });
      const next = new Map(submission.review!.defects);
      params.defects.forEach((entry, index) => next.set(entry.slot, parsed.defects[index]));
      const canonical = parseReviewSubmission({ defects: [...next.values()], summary: "Staged" });
      assertStagedSize(canonical, MAX_CONTROL_ARTIFACT_BYTES, "Review staging");
      submission.review!.defects = next;
      return { stagedDefects: next.size };
    }),
    stagingTool("wiki_review_remove_defect", Type.Object({
      slot: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" }),
    }, { additionalProperties: false }), submission, (params: { slot: string }) => {
      const removed = submission.review!.defects.delete(params.slot);
      return { removed, stagedDefects: submission.review!.defects.size };
    }),
    queryTool("wiki_review_defects", Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }), submission, (params: { offset?: number; limit?: number }) => {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      const defects = [...submission.review!.defects.entries()].map(([slot, defect]) => ({ slot, defect }));
      return { defects: defects.slice(offset, offset + limit), offset, total: defects.length, nextOffset: offset + limit < defects.length ? offset + limit : undefined };
    }),
    queryTool("wiki_submission_status", Type.Object({}, { additionalProperties: false }), submission, () => ({
      defects: submission.review!.defects.size,
      mutations: submission.mutationCount,
      remainingMutations: MAX_STAGING_MUTATIONS - submission.mutationCount,
    })),
  ];
}

function stagingTool(name: string, parameters: any, submission: SubmissionCollector, mutate: (params: any) => unknown | Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name,
    label: name,
    description: "Atomically update the session-local staged submission.",
    parameters,
    async execute(_id, params) {
      return await withCollectorLock(submission, async () => {
        if (submission.value !== undefined) return stagingResult(false, { code: "already_accepted", message: "The terminal submission was already accepted" });
        if (submission.mutationCount >= MAX_STAGING_MUTATIONS) return stagingResult(false, { code: "mutation_budget_exhausted", message: "No staging mutations remain; query staging or submit the terminal result" });
        try {
          const details = await mutate(params);
          submission.mutationCount += 1;
          return stagingResult(true, details);
        } catch (error) {
          return stagingResult(false, { code: "invalid_mutation", message: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}

function queryTool(name: string, parameters: any, lock: QueryLock, query: (params: any) => unknown): ToolDefinition<any, any, any> {
  return {
    name,
    label: name,
    description: "Query session-local staging without consuming mutation or terminal submission attempts.",
    parameters,
    async execute(_id, params) {
      return await withCollectorLock(lock, async () => stagingResult(true, boundedQueryResult(query(params))));
    },
  };
}

function stagingResult(ok: boolean, details: unknown, terminate = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details: { ok, ...(details as object) }, terminate };
}

function boundedQueryResult(details: unknown) {
  if (Buffer.byteLength(JSON.stringify(details), "utf8") <= MAX_QUERY_RESULT_BYTES) return details;
  if (!details || typeof details !== "object") return { truncated: true, message: "Query result exceeded the byte limit" };
  const record = details as Record<string, unknown>;
  const domain = record.domain as Record<string, unknown> | undefined;
  if (domain && Array.isArray(domain.pages)) {
    const domainPages = domain.pages;
    const pageOffset = numericOffset(record.pageOffset);
    const safeDomain = {
      id: boundedText(domain.id, 256),
      title: boundedText(domain.title, 1_024),
      purpose: boundedText(domain.purpose, 2_048),
    };
    return boundArrayPayload(domainPages, pageOffset, (pages, count) => ({
      ...record,
      domain: { ...safeDomain, pages },
      metadataTruncated: domain.id !== safeDomain.id || domain.title !== safeDomain.title || domain.purpose !== safeDomain.purpose || undefined,
      truncated: count < domainPages.length,
      nextOffset: count < domainPages.length ? pageOffset + count : record.nextOffset,
    }));
  }
  const arrayKey = Object.keys(record).find((key) => Array.isArray(record[key]));
  if (!arrayKey) return { truncated: true, message: "Query result exceeded the byte limit; request a narrower page" };
  const items = record[arrayKey] as unknown[];
  const offset = numericOffset(record.offset);
  return boundArrayPayload(items, offset, (values, count) => ({
    ...record,
    [arrayKey]: values,
    truncated: count < items.length,
    nextOffset: count < items.length ? offset + count : record.nextOffset,
  }));
}

function boundArrayPayload(
  items: unknown[],
  offset: number,
  build: (items: unknown[], count: number) => Record<string, unknown>,
) {
  let low = 0;
  let high = items.length;
  let acceptedCount = -1;
  let candidate: Record<string, unknown> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const next = build(items.slice(0, count), count);
    if (Buffer.byteLength(JSON.stringify(next), "utf8") <= MAX_QUERY_RESULT_BYTES) {
      candidate = next;
      acceptedCount = count;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  if (candidate && (acceptedCount > 0 || items.length === 0)) return candidate;
  if (items.length > 0) {
    return {
      truncated: true,
      oversizedItemOmitted: true,
      omittedOffset: offset,
      nextOffset: offset + 1,
      message: "The item at omittedOffset exceeded the query byte limit and was omitted; continue at nextOffset.",
    };
  }
  return { truncated: true, message: "Query metadata exceeded the byte limit; request a narrower page" };
}

function numericOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function boundedText(value: unknown, maxBytes: number): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  const suffix = "...[truncated]";
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle) + suffix, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + suffix;
}

function stagedSpec(submission: SubmissionCollector) {
  return { domains: [...(submission.plan?.domains.values() ?? [])], ...(submission.plan?.coordination ?? {}) };
}

function coordinationCounts(value: { crossLinks: unknown[]; sharedTerms: unknown[]; omissions: unknown[] }) {
  return { crossLinks: value.crossLinks.length, sharedTerms: value.sharedTerms.length, omissions: value.omissions.length };
}

function assertStagedSize(value: unknown, limit: number, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > limit) throw new WikiControlSubmissionSizeError(label, bytes, limit);
}

function pageSubmissionTool(submission: SubmissionCollector): ToolDefinition<any, any, any> {
  const pagePath = submission.pagePath!;
  return {
    name: "wiki_submit_page",
    label: "wiki_submit_page",
    description: `Validate and submit the assigned Wiki page ${pagePath}. Fix every reported issue and resubmit while attempts remain.`,
    promptSnippet: "Validate and submit the assigned Wiki page",
    promptGuidelines: ["After writing the page, call this tool. Fix every returned issue and resubmit while attempts remain. Stop after acceptance or budget exhaustion."],
    parameters: Type.Object({ page: Type.Literal(pagePath) }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: { page: string }) {
      const result = await attemptSubmission(submission, "wiki_submit_page", async () => {
        if (params.page !== pagePath || !submission.validatePage) throw new Error("Page submission does not match the assigned page");
        let validation;
        try {
          validation = await submission.validatePage(pagePath);
        } catch (error) {
          throw new WikiPageValidatorInfrastructureError(error);
        }
        if (!validation.ok) throw new WikiPageValidationError(validation.issues);
        return validation.submission;
      });
      return submissionToolResult(result, `Wiki page accepted: ${pagePath}`);
    },
  };
}

export type SubmissionAttemptResult =
  | { accepted: true }
  | { accepted: false; issues: SubmissionIssue[]; remainingAttempts: number; exhausted: boolean };

export async function attemptSubmission(
  submission: SubmissionCollector,
  toolName: SubmissionToolName,
  parse: () => unknown | Promise<unknown>,
): Promise<SubmissionAttemptResult> {
  return await withCollectorLock(submission, async () => await attemptSubmissionLocked(submission, toolName, parse));
}

async function withCollectorLock<T>(lock: QueryLock, action: () => T | Promise<T>): Promise<T> {
  const previousAttempt = lock.pendingAttempt ?? Promise.resolve();
  let releaseAttempt!: () => void;
  lock.pendingAttempt = new Promise<void>((resolve) => {
    releaseAttempt = resolve;
  });
  await previousAttempt;
  try {
    return await action();
  } finally {
    releaseAttempt();
  }
}

async function attemptSubmissionLocked(
  submission: SubmissionCollector,
  toolName: SubmissionToolName,
  parse: () => unknown | Promise<unknown>,
): Promise<SubmissionAttemptResult> {
  if (submission.value !== undefined) {
    return terminalRejection(submission, [{ path: "$", code: "already_accepted", message: `${submission.acceptedToolName ?? "A submission tool"} was already accepted` }]);
  }
  if (submission.submissionAttempts >= submission.maxSubmissions) {
    return rejection(submission, [{ path: "$", code: "submission_budget_exhausted", message: `No submission attempts remain for ${submission.toolNames.join(" or ")}` }], true);
  }
  submission.submissionAttempts += 1;
  try {
    submission.value = structuredClone(await parse());
    submission.acceptedToolName = toolName;
    submission.failure = undefined;
    submission.exhausted = false;
    return { accepted: true };
  } catch (error) {
    if (error instanceof WikiPageValidatorInfrastructureError) {
      submission.failure = { code: "validator_infrastructure", message: error.message };
      throw error;
    }
    const issues = issuesFor(error);
    const exhausted = submission.submissionAttempts >= submission.maxSubmissions;
    return rejection(submission, issues, exhausted);
  }
}

function terminalRejection(submission: SubmissionCollector, issues: SubmissionIssue[]): SubmissionAttemptResult {
  return {
    accepted: false,
    issues,
    remainingAttempts: Math.max(0, submission.maxSubmissions - submission.submissionAttempts),
    exhausted: true,
  };
}

function rejection(submission: SubmissionCollector, issues: SubmissionIssue[], exhausted: boolean): SubmissionAttemptResult {
  const code: SubmissionFailureCode = issues.some((issue) => issue.code === "submission_too_large")
    ? "submission_too_large"
    : "invalid_submission";
  const remainingAttempts = Math.max(0, submission.maxSubmissions - submission.submissionAttempts);
  submission.exhausted = exhausted;
  submission.failure = {
    code,
    message: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    issues,
    attempts: submission.submissionAttempts,
    remainingAttempts,
  };
  return {
    accepted: false,
    issues,
    remainingAttempts,
    exhausted,
  };
}

function issuesFor(error: unknown): SubmissionIssue[] {
  if (error instanceof WikiPageValidationError) {
    return error.issues.map((issue) => ({ path: "$.page", code: issue.code, message: issue.message }));
  }
  const message = error instanceof Error ? error.message : String(error);
  return [{
    path: issuePathFor(message),
    code: error instanceof WikiControlSubmissionSizeError ? "submission_too_large" : "invalid_value",
    message,
  }];
}

function issuePathFor(message: string): string {
  if (/finding/i.test(message)) return "$.findings";
  if (/gap/i.test(message)) return "$.gaps";
  if (/defect|review/i.test(message)) return "$.defects";
  if (/WikiSpec|synthesis|domain|page/i.test(message)) return "$.spec";
  return "$";
}

function submissionToolResult(result: SubmissionAttemptResult, acceptedMessage: string) {
  const text = result.accepted ? acceptedMessage : JSON.stringify(result);
  return { content: [{ type: "text" as const, text }], details: result, terminate: result.accepted || result.exhausted };
}

class WikiPageValidationError extends Error {
  constructor(readonly issues: Array<{ code: string; message: string }>) {
    super(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"));
  }
}

class WikiPageValidatorInfrastructureError extends Error {
  constructor(cause: unknown) {
    super(`Page validator infrastructure failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
