import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { syncDirectory, writeText } from "../files.js";
import { assertContainedAbsolutePath } from "../path-policy.js";
import {
  createWikiDelegateContract,
  parseWikiDelegateTask,
  parseWikiDelegateContract,
  parseWikiDelegateError,
  parseWikiArtifactRef,
  parseWikiDelegateGap,
  parseWikiDelegateReceipt,
  parseWikiReviewBasis,
  type WikiDelegateContract,
  type WikiDelegateReceipt,
  type WikiReviewBasis,
} from "../delegate-contracts.js";
import type { WikiPinnedSourcePlan, WikiTaskRuntimeState } from "../runtime-types.js";
import type { WikiDelegateBatchSnapshot } from "../delegate-contracts.js";
import { finalizeWiki, materializeValidatedWikiIndexes, type WikiFinalizeFaultPoint } from "./finalize.js";
import { parseWikiSpec, wikiSpecClusterPaths, wikiSpecDomainId, wikiSpecDomainIds, wikiSpecPagePaths, wikiSpecSourceId, wikiSpecSourceIds, type WikiSpec } from "./spec.js";
import { canonicalizeWikiPageContent, formatIssue, resolvePinnedWikiRoots, validateWikiPageContent, type ResolvedWikiRoots } from "./validate.js";
import { parseWikiReviewResult, type WikiReviewResult } from "../delegate-contracts.js";
import {
  digestWikiTree,
  issueWikiPublicationSeal,
  type WikiPublicationSeal,
} from "../wiki-publication-seal.js";
import { sameStringSet, stableStringify } from "../util.js";
import { projectWikiBoard, renderWikiBoard, wikiLeadMayWrite, wikiOpenResearchBlockerIds, type WikiBoardProjectionInput, type WikiBoardTaxonomyCheckpoint, type WikiBoardTaxonomyDecision } from "./board.js";
import { assertDispatchable, type WikiDispatchTaskInput } from "./dispatch.js";
import { UnsupportedWikiRunVersionError, WIKI_FORMAT } from "../run-ledger.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface AcceptedReview extends WikiReviewResult {
  contractId: string;
  contractDigest: string;
  basis: WikiReviewBasis;
}

interface WikiLeadRunState {
  version: typeof WIKI_FORMAT;
  runId: string;
  candidateRevision: number;
  specRevision: number;
  policyDigest: string;
  compactionObserved: boolean;
  sourceScopeIds: string[];
  spec?: WikiSpec;
  taxonomy?: WikiBoardTaxonomyCheckpoint;
  reviews: AcceptedReview[];
  delegates: WikiTaskRuntimeState;
}

export interface WikiLeadSpecRecord {
  revision: number;
  spec: WikiSpec;
}

export interface WikiTaxonomyInput {
  revision: number;
  decisions: readonly WikiBoardTaxonomyDecision[];
  conflictIds: readonly string[];
}

interface CandidateTransaction {
  version: typeof WIKI_FORMAT;
  runId: string;
  path: string;
  staged: string;
  oldDigest: string | null;
  newDigest: string;
  nextState: WikiLeadRunState;
}

export type WikiCandidateFaultPoint = "afterStage" | "afterJournal" | "afterState" | "afterRename" | "afterVerify";
export type WikiLeadFinalizeFaultPoint = "afterFinalizeJournal" | WikiFinalizeFaultPoint | "afterFinalize" | "afterSeal";

export interface WikiLeadRunOptions {
  workspace: string;
  runId: string;
  candidateWikiRoot: string;
  policy: unknown;
  requiredSections?: readonly string[];
  fault?: (point: WikiCandidateFaultPoint) => void | Promise<void>;
  finalizeFault?: (point: WikiLeadFinalizeFaultPoint) => void | Promise<void>;
  /** Authoritative lifecycle execution checked under the Lead lease before every operation. */
  assertActive: () => Promise<void>;
  executionToken: string;
  sourcePlan?: WikiPinnedSourcePlan;
  /** Host-owned source scope IDs used when a pinned source plan is unavailable. */
  allowedSourceScopeIds?: readonly string[];
  language?: "zh" | "en";
  /** Run-wide queue budget; admission/concurrency is enforced by WikiTaskRuntime. */
  maxDelegatedTasks?: number;
}

export interface WikiTaskRuntimeTransitions {
  batchQueued(contracts: readonly WikiDelegateContract[]): Promise<void>;
  taskStarted(batchId: number, taskId: string, input: {
    attempt: number;
    sessionFile?: string;
    partial?: WikiTaskRuntimeState["batches"][number]["tasks"][number]["partial"];
  }): Promise<void>;
  taskPaused(batchId: number, taskId: string, input: {
    attempt: number;
    pause?: WikiDelegateReceipt["error"];
    sessionFile?: string;
    partial?: WikiTaskRuntimeState["batches"][number]["tasks"][number]["partial"];
  }): Promise<void>;
  taskSettled(batchId: number, taskId: string, input: {
    attempt: number;
    receipt: WikiDelegateReceipt;
    sessionFile?: string;
  }): Promise<void>;
  tasksCollected(batchId: number, taskIds: readonly string[]): Promise<void>;
}

interface PublicationFinalizationTransaction {
  version: typeof WIKI_FORMAT;
  runId: string;
  candidateRevision: number;
  policyDigest: string;
  preTreeDigest: string;
  publicationAt: string;
  requiredPaths: string[];
  requiredProfileCoverage: string[];
  preimageRoot: string;
}

interface TransitionContext {
  reviews: AcceptedReview[];
  currentTreeDigest: string;
  candidateRevision: number;
  policyDigest: string;
}

/** Run-scoped owner of WikiSpec, candidate revision, delegated contracts and review acceptance. */
export class WikiLeadRun {
  private chain = Promise.resolve();

  private constructor(
    private readonly workspace: string,
    readonly runId: string,
    readonly candidateWikiRoot: string,
    private readonly stateFile: string,
    private readonly journalFile: string,
    private readonly lockFile: string,
    private readonly requiredSections: readonly string[],
    private readonly fault: WikiLeadRunOptions["fault"],
    private readonly finalizeFault: WikiLeadRunOptions["finalizeFault"],
    private readonly assertActive: WikiLeadRunOptions["assertActive"],
    private readonly executionToken: string,
    private readonly pinnedRoots: ResolvedWikiRoots | undefined,
    private readonly maxDelegatedTasks: number | undefined,
    private state: WikiLeadRunState,
  ) {}

  static async open(options: WikiLeadRunOptions): Promise<WikiLeadRun> {
    if (!SAFE_RUN_ID.test(options.runId)) throw new Error("Invalid Wiki Lead run id");
    await assertExecutionActive(options.assertActive, options.executionToken);
    const workspace = path.resolve(options.workspace);
    const candidate = path.resolve(options.candidateWikiRoot);
    await mkdir(candidate, { recursive: true });
    await assertContainedAbsolutePath(workspace, candidate, false, "Wiki workspace");
    const runRoot = path.join(workspace, ".okf-wiki", "runs", options.runId);
    await mkdir(runRoot, { recursive: true });
    const stateFile = path.join(runRoot, "lead-state.json");
    const journalFile = path.join(runRoot, "candidate-transaction.json");
    const lockFile = path.join(runRoot, "lead-operation.lock");
    const policyDigest = hash(stableStringify(options.policy));
    const configuredSourceScopeIds = unique(options.sourcePlan?.sources.map((source) => source.scopeId) ?? options.allowedSourceScopeIds ?? []);
    let state = await readState(stateFile, options.runId);
    if (state && configuredSourceScopeIds.length && !sameStringSet(state.sourceScopeIds, configuredSourceScopeIds)) {
      throw new Error("Pinned source scope IDs do not match the durable Wiki Lead run");
    }
    state ??= emptyState(options.runId, policyDigest, configuredSourceScopeIds);
    if (!state.sourceScopeIds.length && configuredSourceScopeIds.length) state = { ...state, sourceScopeIds: configuredSourceScopeIds };
    const pinnedRoots = options.sourcePlan
      ? await resolvePinnedWikiRoots(options.sourcePlan, options.language ?? "en", candidateDirectory(workspace, candidate))
      : undefined;
    const subject = new WikiLeadRun(workspace, options.runId, candidate, stateFile, journalFile, lockFile, options.requiredSections ?? [], options.fault, options.finalizeFault, options.assertActive, options.executionToken, pinnedRoots, options.maxDelegatedTasks, state);
    await subject.serial(async () => {
      await subject.recover();
      if (subject.state.policyDigest !== policyDigest) {
        subject.state = { ...subject.state, policyDigest, candidateRevision: subject.state.candidateRevision + 1, reviews: [] };
      }
      // Re-materialize the host board on every reopen so a missing or stale projection cannot survive compaction.
      await subject.writeState(subject.state);
    });
    return subject;
  }

  get specRecord(): WikiLeadSpecRecord | undefined {
    return this.state.spec ? { revision: this.state.specRevision, spec: structuredClone(this.state.spec) } : undefined;
  }

  get taxonomyCheckpoint(): WikiBoardTaxonomyCheckpoint | undefined {
    return this.state.taxonomy ? structuredClone(this.state.taxonomy) : undefined;
  }

  get compactionObserved(): boolean { return this.state.compactionObserved; }

  get taskRuntimeState(): WikiTaskRuntimeState { return structuredClone(this.state.delegates); }

  async saveTaxonomy(value: unknown): Promise<WikiBoardTaxonomyCheckpoint> {
    return await this.serial(async () => {
      await this.recover();
      if (this.state.spec) throw new Error("Wiki taxonomy must be accepted before wiki_plan");
      const checkpoint = parseTaxonomyCheckpoint(value);
      assertTaxonomySources(checkpoint, this.state.sourceScopeIds);
      if (this.state.taxonomy && checkpoint.revision <= this.state.taxonomy.revision) {
        throw new Error(`Wiki taxonomy revision must advance beyond ${this.state.taxonomy.revision}`);
      }
      const next = { ...this.state, taxonomy: checkpoint };
      await this.writeState(next);
      this.state = next;
      return structuredClone(checkpoint);
    });
  }

  async saveSpec(specValue: unknown, expectedRevision = this.state.specRevision): Promise<WikiLeadSpecRecord> {
    return await this.serial(async () => {
      await this.recover();
      if (!this.state.taxonomy?.accepted) throw new Error("Accept a Wiki taxonomy checkpoint with wiki_taxonomy before wiki_plan");
      assertResearchReady(this.state);
      if (expectedRevision !== this.state.specRevision) throw new Error(`WikiSpec revision conflict: expected ${expectedRevision}, found ${this.state.specRevision}`);
      const spec = parseWikiSpec(specValue);
      assertTaxonomyOwnership(this.state.taxonomy, spec, this.state.sourceScopeIds);
      const next = { ...this.state, spec, specRevision: this.state.specRevision + 1, candidateRevision: this.state.candidateRevision + 1, reviews: [] };
      await this.writeState(next);
      this.state = next;
      await this.tryIndexes();
      return { revision: next.specRevision, spec: structuredClone(spec) };
    });
  }

  async observeCompaction(): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      if (this.state.compactionObserved) return;
      this.state = { ...this.state, compactionObserved: true };
      await this.writeState(this.state);
    });
  }

  async replacePage(input: { path: string; content: string; actor: "lead" | "writer" }): Promise<{ candidateRevision: number; digest: string }> {
    return await this.serial(async () => {
      await this.recover();
      const spec = this.requireSpec();
      const relative = stripWikiPrefix(input.path);
      if (!wikiSpecPagePaths(spec).includes(relative)) throw new Error(`Wiki page is not declared by the current WikiSpec: ${input.path}`);
      if (input.actor === "lead" && !wikiLeadMayWrite(spec, this.state.compactionObserved)) {
        throw new Error("Lead direct writing is disabled for this WikiSpec or after context compaction; delegate an exact-path writer");
      }
      const issues = await validateWikiPageContent(this.workspace, spec, relative, input.content, candidateDirectory(this.workspace, this.candidateWikiRoot), undefined, this.requiredSections, this.pinnedRoots);
      if (issues.length) throw new Error(`Wiki page validation failed before write: ${issues.map(formatIssue).join("; ")}`);
      const canonical = canonicalizeWikiPageContent(input.content);
      const target = path.join(this.candidateWikiRoot, ...relative.split("/"));
      await assertContainedAbsolutePath(this.candidateWikiRoot, target, true, "candidate Wiki");
      await assertRegularOrMissing(target);
      await mkdir(path.dirname(target), { recursive: true });
      const staged = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.candidate`);
      await writeDurableNew(staged, canonical);
      await this.fault?.("afterStage");
      const oldDigest = await fileDigest(target);
      const newDigest = hash(canonical);
      const nextState: WikiLeadRunState = { ...this.state, candidateRevision: this.state.candidateRevision + 1, reviews: [] };
      const transaction: CandidateTransaction = { version: WIKI_FORMAT, runId: this.runId, path: relative, staged, oldDigest, newDigest, nextState };
      await writeText(this.journalFile, `${JSON.stringify(transaction, null, 2)}\n`);
      await this.fault?.("afterJournal");
      await this.writeState(nextState);
      this.state = nextState;
      await this.fault?.("afterState");
      await rename(staged, target);
      await syncDirectory(path.dirname(target));
      await this.fault?.("afterRename");
      if (await fileDigest(target) !== newDigest) throw new WikiCandidateCorruptionError(`Candidate page digest mismatch after replacement: ${relative}`);
      await this.fault?.("afterVerify");
      await rm(this.journalFile, { force: true });
      await syncDirectory(path.dirname(this.journalFile));
      await this.tryIndexes();
      return { candidateRevision: nextState.candidateRevision, digest: newDigest };
    });
  }

  /** Create and durably queue an entire batch before any Agent may launch. */
  async dispatch(values: readonly unknown[]): Promise<{ batchId: number; contracts: WikiDelegateContract[] }> {
    return await this.serial(async () => {
      await this.recover();
      const batchId = this.state.delegates.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId + 1), 1);
      if (!Number.isSafeInteger(batchId)) throw new Error("Delegate batch identity is exhausted");
      const existingResearchTasks = this.state.delegates.batches.flatMap((batch) => batch.tasks)
        .filter((item) => item.task.role === "research")
        .map((item) => {
          const task = item.task;
          if (task.role !== "research") throw new Error("Internal research task projection mismatch");
          const receipt = item?.receipt;
          return {
            id: task.id,
            mode: task.mode,
            assignmentIds: task.assignmentIds,
            resolvesIds: task.resolvesIds,
            ...(receipt ? { receipt: {
              status: receipt.status,
              ...(receipt.error ? { error: { code: receipt.error.code } } : {}),
              ...(receipt.gaps ? { gaps: receipt.gaps } : {}),
              ...(receipt.followups ? { followups: receipt.followups.map((followup) => ({ id: followup.id })) } : {}),
            } } : {}),
          };
      });
      const dispatchTasks: WikiDispatchTaskInput[] = values.map(dispatchTaskInput)
        .map((task, index) => expandDispatchTask(task, this.state.spec, existingResearchTasks, `a-b${batchId}-t${index + 1}`) as WikiDispatchTaskInput);
      assertDispatchable({
        tasks: dispatchTasks,
        spec: this.state.spec,
        pendingWritePaths: pendingWritePaths(this.state),
        knownContextRefs: knownContextRefs(this.state),
        delegatedTasks: delegatedTaskCount(this.state),
        delegateBatches: this.state.delegates.batches.length,
        maxDelegatedTasks: this.maxDelegatedTasks,
        existingResearchTasks,
        knownResearchBlockerIds: wikiOpenResearchBlockerIds(this.state.delegates.batches.flatMap((batch) => batch.tasks).map(researchBlockerTask)),
      });
      if ((values.some((value) => taskRole(value) === "write" || taskRole(value) === "review"))
        && (!this.state.taxonomy?.accepted || !this.state.spec || !researchReady(this.state))) {
        throw new Error("Wiki write/review dispatch requires an accepted taxonomy, WikiSpec, and complete research wave");
      }
      const parsed = dispatchTasks.map((value) => {
        const { cluster: _cluster, ...contractInput } = value;
        return parseWikiDelegateTask(contractInput);
      });
      const reviewTree = parsed.some((task) => task.role === "review") ? await this.prepareReviewTree() : undefined;
      const contracts = parsed.map((task) => createWikiDelegateContract(
        batchId,
        task,
        task.role === "review" ? this.reviewBasis(task.reviewPaths, reviewTree!) : undefined,
      ));
      const batch = {
        batchId,
        tasks: contracts.map((task) => ({ task, phase: "queued" as const, attempt: 0, collected: false })),
      };
      const next = { ...this.state, delegates: { batches: [...this.state.delegates.batches, batch] } };
      await this.commitState(next);
      return { batchId, contracts: structuredClone(contracts) };
    });
  }

  /** Remove a still-queued batch so a failed start can mint again. */
  async rollbackDelegateBatch(batchId: number): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const batchIndex = this.state.delegates.batches.findIndex((batch) => batch.batchId === batchId);
      if (batchIndex < 0) throw new Error(`Unknown delegate batch: ${batchId}`);
      const batch = this.state.delegates.batches[batchIndex];
      if (batch.tasks.some((task) => task.phase !== "queued" || task.attempt !== 0 || task.collected)) {
        throw new Error(`Cannot roll back delegate batch ${batchId} after launch`);
      }
      const batches = this.state.delegates.batches.filter((_, index) => index !== batchIndex);
      await this.commitState({ ...this.state, delegates: { batches } });
    });
  }

  readonly taskTransitions: WikiTaskRuntimeTransitions = {
    batchQueued: async (values) => await this.serial(async () => {
      await this.recover();
      const contracts = values.map(parseWikiDelegateContract);
      if (!contracts.length || contracts.some((contract) => contract.batchId !== contracts[0].batchId)) throw new Error("Queued delegate contracts must belong to one batch");
      const saved = this.state.delegates.batches.find((batch) => batch.batchId === contracts[0].batchId);
      if (!saved || saved.tasks.length !== contracts.length || saved.tasks.some((task, index) => task.phase !== "queued"
        || task.attempt !== 0 || task.collected || task.task.contractDigest !== contracts[index].contractDigest)) {
        throw new Error("Delegate batch must be durably queued by WikiLeadRun before launch");
      }
    }),
    taskStarted: async (batchId, taskId, input) => await this.transitionTask(batchId, taskId, (current) => {
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error("Invalid delegate attempt");
      if (current.phase === "terminal") throw new Error(`Terminal delegate task cannot restart: ${taskId}`);
      if (input.attempt < current.attempt || input.attempt > current.attempt + 1) throw new Error(`Delegate attempt is not monotonic: ${taskId}`);
      if (current.phase === "paused" && input.attempt !== current.attempt) throw new Error(`Paused delegate task must resume its current attempt: ${taskId}`);
      return {
        ...current,
        phase: "running",
        attempt: input.attempt,
        collected: false,
        sessionFile: input.sessionFile,
        ...(input.partial ? { partial: structuredClone(input.partial) } : {}),
        pause: undefined,
        receipt: undefined,
      };
    }),
    taskPaused: async (batchId, taskId, input) => await this.transitionTask(batchId, taskId, (current) => {
      if (current.phase !== "running" || input.attempt !== current.attempt) throw new Error(`Only the current running attempt may pause: ${taskId}`);
      const pause = input.pause === undefined ? undefined : parseWikiDelegateError(input.pause);
      return {
        ...current,
        phase: "paused",
        collected: false,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        ...(input.partial ? { partial: structuredClone(input.partial) } : {}),
        ...(pause ? { pause } : {}),
        receipt: undefined,
      };
    }),
    taskSettled: async (batchId, taskId, input) => await this.transitionTask(batchId, taskId, (current, state) => {
      if (current.phase !== "running" || input.attempt !== current.attempt) throw new Error(`Only the current running attempt may settle: ${taskId}`);
      const contract = parseWikiDelegateContract(current.task);
      const receipt = parseWikiDelegateReceipt(input.receipt);
      assertReceiptForContract(receipt, contract, input.attempt, this.runId);
      const next = {
        ...current,
        phase: "terminal" as const,
        collected: false,
        receipt,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        pause: undefined,
        partial: undefined,
      };
      if (contract.role === "review" && receipt.review && contract.reviewBasis) {
        const accepted = sameBasis(contract.reviewBasis, state, state.currentTreeDigest)
          && sameStringSet(receipt.review.reviewedPaths, contract.reviewPaths);
        state.reviews = state.reviews.filter((review) => review.contractId !== contract.contractId);
        if (accepted) state.reviews.push({
          ...structuredClone(receipt.review),
          contractId: contract.contractId,
          contractDigest: contract.contractDigest,
          basis: contract.reviewBasis,
        });
      }
      return next;
    }),
    tasksCollected: async (batchId, taskIds) => await this.serial(async () => {
      await this.recover();
      const unique = [...new Set(taskIds)];
      if (!unique.length) return;
      const batchIndex = this.state.delegates.batches.findIndex((batch) => batch.batchId === batchId);
      if (batchIndex < 0) throw new Error(`Unknown delegate batch: ${batchId}`);
      const batch = this.state.delegates.batches[batchIndex];
      const requested = new Set(unique);
      if (unique.some((taskId) => !batch.tasks.some((task) => task.task.id === taskId))) throw new Error(`Unknown delegate task in batch ${batchId}`);
      const tasks = batch.tasks.map((task) => {
        if (!requested.has(task.task.id)) return task;
        if (task.phase !== "terminal") throw new Error(`Only terminal delegate tasks may be collected: ${task.task.id}`);
        return task.collected ? task : { ...task, collected: true };
      });
      await this.commitState(replaceBatch(this.state, batchIndex, { ...batch, tasks }));
    }),
  };

  async finish(requiredPaths?: readonly string[], requiredProfileCoverage: readonly string[] = []): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const paths = requiredPaths ?? wikiSpecPagePaths(this.requireSpec()).map((page) => `wiki/${page}`);
      await this.assertPublishableAtTree(paths, requiredProfileCoverage, await digestWikiTree(this.candidateWikiRoot));
    });
  }

  async sealForPublication(input: {
    requiredPaths?: readonly string[];
    requiredProfileCoverage: readonly string[];
    publicationAt?: string;
    sourceFingerprint: string;
    summary: string;
  }): Promise<WikiPublicationSeal> {
    return await this.serial(async () => {
      await this.recover();
      const transaction = await this.preparePublicationFinalization(input);
      await restoreSafeTree(transaction.preimageRoot, this.candidateWikiRoot, transaction.preTreeDigest);
      await finalizeWiki(
        this.workspace,
        this.requireSpec(),
        candidateDirectory(this.workspace, this.candidateWikiRoot),
        transaction.publicationAt,
        this.requiredSections,
        { fault: async (point) => await this.finalizeFault?.(point), pinnedRoots: this.pinnedRoots },
      );
      await this.finalizeFault?.("afterFinalize");
      const seal = await issueWikiPublicationSeal({
        runId: this.runId,
        executionToken: this.executionToken,
        candidateRoot: this.candidateWikiRoot,
        pages: wikiSpecPagePaths(this.requireSpec()),
        spec: this.requireSpec(),
        sourceFingerprint: input.sourceFingerprint,
        summary: input.summary,
      });
      await this.finalizeFault?.("afterSeal");
      return seal;
    });
  }

  async presentSnapshot(snapshot: WikiDelegateBatchSnapshot): Promise<WikiDelegateBatchSnapshot> {
    return await this.serial(async () => {
      await this.recover();
      const tree = await digestWikiTree(this.candidateWikiRoot);
      return {
        ...snapshot,
        receipts: snapshot.receipts.map((receipt) => {
          if (receipt.role !== "review" || receipt.status !== "complete") return receipt;
          const accepted = this.state.reviews.some((review) => review.contractId === receipt.contractId
            && review.contractDigest === receipt.contractDigest && sameBasis(review.basis, this.state, tree));
          return accepted ? receipt : { ...receipt, status: "incomplete" as const, summary: "Review became stale while the delegated task was running", review: undefined };
        }),
      };
    });
  }

  private async prepareReviewTree(): Promise<string> {
    const spec = this.requireSpec();
    await materializeValidatedWikiIndexes(this.workspace, spec, candidateDirectory(this.workspace, this.candidateWikiRoot), undefined, this.requiredSections, this.pinnedRoots);
    return await digestWikiTree(this.candidateWikiRoot);
  }

  private reviewBasis(paths: readonly string[], treeDigest: string): WikiReviewBasis {
    const declared = new Set(wikiSpecPagePaths(this.requireSpec()).map((value) => `wiki/${value}`));
    const unique = [...new Set(paths)].sort();
    if (!unique.length || unique.some((value) => !declared.has(value))) throw new Error("Review paths must be non-empty and declared by the current WikiSpec");
    return { version: WIKI_FORMAT, candidateRevision: this.state.candidateRevision, treeDigest, policyDigest: this.state.policyDigest, paths: unique };
  }

  private async transitionTask(
    batchId: number,
    taskId: string,
    transition: (current: WikiTaskRuntimeState["batches"][number]["tasks"][number], context: TransitionContext) => WikiTaskRuntimeState["batches"][number]["tasks"][number],
  ): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      const batchIndex = this.state.delegates.batches.findIndex((batch) => batch.batchId === batchId);
      if (batchIndex < 0) throw new Error(`Unknown delegate batch: ${batchId}`);
      const batch = this.state.delegates.batches[batchIndex];
      const taskIndex = batch.tasks.findIndex((task) => task.task.id === taskId);
      if (taskIndex < 0) throw new Error(`Unknown delegate task ${taskId} in batch ${batchId}`);
      const context: TransitionContext = {
        reviews: [...this.state.reviews],
        currentTreeDigest: await digestWikiTree(this.candidateWikiRoot),
        candidateRevision: this.state.candidateRevision,
        policyDigest: this.state.policyDigest,
      };
      const nextTask = transition(structuredClone(batch.tasks[taskIndex]), context);
      const tasks = [...batch.tasks];
      tasks[taskIndex] = nextTask;
      const next = replaceBatch({ ...this.state, reviews: context.reviews }, batchIndex, { ...batch, tasks });
      await this.commitState(next);
    });
  }

  private async assertPublishableAtTree(
    requiredPaths: readonly string[],
    requiredProfileCoverage: readonly string[],
    tree: string,
  ): Promise<void> {
    const board = projectWikiBoard(boardInput(this.state));
    const blocked = board.clusters.find((cluster) => cluster.status === "blocked");
    if (blocked) throw new Error(`Wiki cluster is blocked after 3 write/review attempts: ${blocked.id}`);
    const current = this.state.reviews.filter((review) => sameBasis(review.basis, this.state, tree));
    const requested = current.find((review) => review.verdict === "changes_requested");
    if (requested) throw new Error(`Wiki review requested changes in contract ${requested.contractId}`);
    const covered = new Set(current.filter((review) => review.verdict === "pass").flatMap((review) => review.reviewedPaths));
    const missing = requiredPaths.filter((page) => !covered.has(page));
    if (missing.length) throw new Error(`Current Wiki revision lacks passing independent review for: ${missing.join(", ")}`);
    const profile = new Set(current.filter((review) => review.verdict === "pass").flatMap((review) => review.profileCoverage));
    const missingProfile = requiredProfileCoverage.filter((item) => !profile.has(item));
    if (missingProfile.length) throw new Error(`Current Wiki review does not cover profile requirements: ${missingProfile.join(", ")}`);
  }

  private async preparePublicationFinalization(input: {
    requiredPaths?: readonly string[];
    requiredProfileCoverage: readonly string[];
    publicationAt?: string;
  }): Promise<PublicationFinalizationTransaction> {
    const runRoot = path.dirname(this.stateFile);
    const transactionFile = path.join(runRoot, "publication-finalization.json");
    const requiredPaths = input.requiredPaths ?? wikiSpecPagePaths(this.requireSpec()).map((page) => `wiki/${page}`);
    const saved = await readPublicationTransaction(transactionFile, this.runId);
    if (saved) {
      if (path.resolve(saved.preimageRoot) !== path.join(runRoot, "publication-preimage")) throw new Error("Publication preimage path is not run-owned");
      if (saved.candidateRevision !== this.state.candidateRevision || saved.policyDigest !== this.state.policyDigest
        || !sameStringSet(saved.requiredPaths, requiredPaths)
        || !sameStringSet(saved.requiredProfileCoverage, input.requiredProfileCoverage)
        || input.publicationAt !== undefined && input.publicationAt !== saved.publicationAt) {
        throw new Error("Publication finalization request no longer matches the reviewed Candidate Revision");
      }
      await this.assertPublishableAtTree(saved.requiredPaths, saved.requiredProfileCoverage, saved.preTreeDigest);
      if (await digestWikiTree(saved.preimageRoot) !== saved.preTreeDigest) throw new WikiCandidateCorruptionError("Publication preimage was modified");
      return saved;
    }
    const preTreeDigest = await digestWikiTree(this.candidateWikiRoot);
    await this.assertPublishableAtTree(requiredPaths, input.requiredProfileCoverage, preTreeDigest);
    const preimageRoot = path.join(runRoot, "publication-preimage");
    await rm(preimageRoot, { recursive: true, force: true });
    await copySafeTree(this.candidateWikiRoot, preimageRoot);
    if (await digestWikiTree(preimageRoot) !== preTreeDigest) throw new WikiCandidateCorruptionError("Publication preimage digest mismatch");
    const transaction: PublicationFinalizationTransaction = {
      version: WIKI_FORMAT,
      runId: this.runId,
      candidateRevision: this.state.candidateRevision,
      policyDigest: this.state.policyDigest,
      preTreeDigest,
      publicationAt: input.publicationAt ?? new Date().toISOString(),
      requiredPaths: [...new Set(requiredPaths)].sort(),
      requiredProfileCoverage: [...new Set(input.requiredProfileCoverage)].sort(),
      preimageRoot,
    };
    await writeText(transactionFile, `${JSON.stringify(transaction, null, 2)}\n`);
    await this.finalizeFault?.("afterFinalizeJournal");
    return transaction;
  }

  private async recover(): Promise<void> {
    const transaction = await readTransaction(this.journalFile, this.runId);
    if (!transaction) {
      this.state = await readState(this.stateFile, this.runId) ?? this.state;
      return;
    }
    const target = path.join(this.candidateWikiRoot, ...transaction.path.split("/"));
    await assertContainedAbsolutePath(this.candidateWikiRoot, target, true, "candidate Wiki");
    const targetDigest = await fileDigest(target);
    if (targetDigest !== transaction.oldDigest && targetDigest !== transaction.newDigest) {
      throw new WikiCandidateCorruptionError(`Cannot recover externally modified candidate page: ${transaction.path}`);
    }
    await this.writeState(transaction.nextState);
    this.state = transaction.nextState;
    if (targetDigest === transaction.oldDigest) {
      if (await fileDigest(transaction.staged) !== transaction.newDigest) throw new WikiCandidateCorruptionError(`Cannot recover missing or modified staged page: ${transaction.path}`);
      await rename(transaction.staged, target);
      await syncDirectory(path.dirname(target));
    }
    if (await fileDigest(target) !== transaction.newDigest) throw new WikiCandidateCorruptionError(`Candidate recovery digest mismatch: ${transaction.path}`);
    await rm(transaction.staged, { force: true });
    await rm(this.journalFile, { force: true });
    await syncDirectory(path.dirname(this.journalFile));
    await this.tryIndexes();
  }

  private async tryIndexes(): Promise<void> {
    if (!this.state.spec) return;
    try { await materializeValidatedWikiIndexes(this.workspace, this.state.spec, candidateDirectory(this.workspace, this.candidateWikiRoot), undefined, this.requiredSections, this.pinnedRoots); } catch { /* incomplete candidates have no indexes yet */ }
  }

  private requireSpec(): WikiSpec {
    if (!this.state.spec) throw new Error("Submit an accepted WikiSpec with wiki_plan before writing or reviewing Wiki pages");
    return this.state.spec;
  }

  private async commitState(next: WikiLeadRunState): Promise<void> {
    const parsed = parseState(JSON.parse(serializeState(next)), this.runId);
    await this.writeState(parsed);
    this.state = parsed;
  }

  private async writeState(state: WikiLeadRunState): Promise<void> {
    await writeText(this.stateFile, serializeState(state));
    await writeText(path.join(path.dirname(this.stateFile), "board.md"), renderWikiBoard(projectWikiBoard(boardInput(state))));
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const next = this.chain.catch(() => {}).then(async () => {
      const release = await acquireRunLease(this.lockFile);
      try {
        await assertExecutionActive(this.assertActive, this.executionToken);
        result = await operation();
      }
      finally { await release(); }
    });
    this.chain = next.catch(() => {});
    await next;
    return result;
  }
}

async function assertExecutionActive(assertActive: WikiLeadRunOptions["assertActive"], executionToken: string): Promise<void> {
  if (typeof assertActive !== "function" || typeof executionToken !== "string" || !executionToken.trim()) {
    throw new WikiLeadExecutionFencedError("Invalid Wiki Lead execution fence");
  }
  try {
    await assertActive();
  } catch (error) {
    if (error instanceof WikiLeadExecutionFencedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WikiLeadExecutionFencedError(message);
  }
}

export class WikiCandidateCorruptionError extends Error {
  constructor(message: string) { super(message); this.name = "WikiCandidateCorruptionError"; }
}

export class WikiLeadExecutionFencedError extends Error {
  constructor(message: string) { super(message); this.name = "WikiLeadExecutionFencedError"; }
}

function emptyState(runId: string, policyDigest: string, sourceScopeIds: readonly string[]): WikiLeadRunState {
  return { version: WIKI_FORMAT, runId, candidateRevision: 0, specRevision: 0, policyDigest, compactionObserved: false, sourceScopeIds: [...sourceScopeIds], reviews: [], delegates: { batches: [] } };
}

async function readState(location: string, runId: string): Promise<WikiLeadRunState | undefined> {
  try { return parseState(JSON.parse(await readFile(location, "utf8")), runId); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function parseState(value: unknown, runId: string, requireDigest = true): WikiLeadRunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  const raw = value as unknown as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["version", "runId", "candidateRevision", "specRevision", "policyDigest", "compactionObserved", "sourceScopeIds", "spec", "taxonomy", "reviews", "delegates", "stateDigest"].includes(key))) throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  const { stateDigest, ...body } = raw;
  if (requireDigest && (typeof stateDigest !== "string" || stateDigest !== hash(stableStringify(body)))) throw new Error(`Wiki Lead run state integrity check failed for ${runId}`);
  if (raw.version !== WIKI_FORMAT) throw new UnsupportedWikiRunVersionError(`runs/${runId}/lead-state.json`, raw.version);
  if (raw.runId !== runId || !Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0
    || !Number.isSafeInteger(raw.specRevision) || (raw.specRevision as number) < 0 || typeof raw.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.policyDigest)
    || typeof raw.compactionObserved !== "boolean" || raw.sourceScopeIds !== undefined && (!Array.isArray(raw.sourceScopeIds) || raw.sourceScopeIds.some((id) => typeof id !== "string" || !id) || new Set(raw.sourceScopeIds).size !== raw.sourceScopeIds.length) || !Array.isArray(raw.reviews) || !raw.delegates
    || (raw.spec === undefined) !== (raw.specRevision === 0)) throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  return {
    version: WIKI_FORMAT,
    runId,
    candidateRevision: raw.candidateRevision as number,
    specRevision: raw.specRevision as number,
    policyDigest: raw.policyDigest as string,
    compactionObserved: raw.compactionObserved,
    sourceScopeIds: raw.sourceScopeIds === undefined ? [] : [...raw.sourceScopeIds] as string[],
    ...(raw.spec ? { spec: parseWikiSpec(raw.spec) } : {}),
    ...(raw.taxonomy ? { taxonomy: parseTaxonomyCheckpoint(raw.taxonomy) } : {}),
    reviews: raw.reviews.map(parseAcceptedReview),
    delegates: parseDelegateState(raw.delegates),
  };
}

function parseTaxonomyCheckpoint(value: unknown): WikiBoardTaxonomyCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki taxonomy checkpoint");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["accepted", "revision", "decisions", "conflictIds", "digest"].includes(key))) throw new Error("Invalid Wiki taxonomy checkpoint");
  if (raw.accepted !== undefined && raw.accepted !== true || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 || !Array.isArray(raw.decisions) || !Array.isArray(raw.conflictIds)) {
    throw new Error("Invalid Wiki taxonomy checkpoint");
  }
  const decisions: WikiBoardTaxonomyDecision[] = raw.decisions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Wiki taxonomy decision");
    const decision = entry as Record<string, unknown>;
    if (Object.keys(decision).some((key) => !["sourceScopeId", "domainId", "conceptIds"].includes(key))
      || typeof decision.sourceScopeId !== "string" || !decision.sourceScopeId
      || typeof decision.domainId !== "string" || !decision.domainId
      || !Array.isArray(decision.conceptIds) || decision.conceptIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Invalid Wiki taxonomy decision");
    }
    return { sourceScopeId: decision.sourceScopeId, domainId: decision.domainId, conceptIds: [...decision.conceptIds] as string[] };
  });
  const conflictIds = raw.conflictIds.map((id) => {
    if (typeof id !== "string" || !id) throw new Error("Invalid Wiki taxonomy conflict ID");
    return id;
  });
  const body = { revision: raw.revision, decisions, conflictIds };
  const digest = raw.digest === undefined ? hash(stableStringify(body)) : raw.digest;
  if (typeof digest !== "string" || digest !== hash(stableStringify(body))) throw new Error("Wiki taxonomy checkpoint digest mismatch");
  return { accepted: true, revision: raw.revision as number, decisions, conflictIds, digest };
}

function assertTaxonomySources(checkpoint: WikiBoardTaxonomyCheckpoint, allowedSourceScopeIds: readonly string[]): void {
  const allowed = new Set(allowedSourceScopeIds);
  for (const decision of checkpoint.decisions) {
    if (!allowed.has(decision.sourceScopeId)) throw new Error(`Wiki taxonomy references undeclared source scope: ${decision.sourceScopeId}`);
  }
}

function assertTaxonomyOwnership(checkpoint: WikiBoardTaxonomyCheckpoint, spec: WikiSpec, allowedSourceScopeIds: readonly string[]): void {
  assertTaxonomySources(checkpoint, allowedSourceScopeIds);
  const specSourceIds = wikiSpecSourceIds(spec);
  for (const decision of checkpoint.decisions) {
    // Source scopes are pinned physical IDs; a single-source spec may use a different
    // authored namespace, while multi-source specs must identify their authored source.
    const ownedSources = specSourceIds.includes(decision.sourceScopeId) ? [decision.sourceScopeId] : specSourceIds.length === 1 ? specSourceIds : [];
    if (!ownedSources.some((sourceId) => wikiSpecDomainIds(spec, sourceId).includes(decision.domainId))) {
      throw new Error(`Wiki taxonomy domain is not owned by source ${decision.sourceScopeId}: ${decision.domainId}`);
    }
    const concepts = new Set(spec.pages.flatMap((page) => {
      if (!ownedSources.includes(wikiSpecSourceId(page) ?? "") || wikiSpecDomainId(page) !== decision.domainId) return [];
      const segments = page.split("/");
      return segments.length >= 4 ? [segments[2]] : [];
    }));
    for (const conceptId of decision.conceptIds) {
      if (!concepts.has(conceptId)) throw new Error(`Wiki taxonomy concept is not owned by ${decision.sourceScopeId}/${decision.domainId}: ${conceptId}`);
    }
  }
}

function assertResearchReady(state: WikiLeadRunState): void {
  if (!researchReady(state)) throw new Error("Wiki taxonomy cannot be planned until the discovery research wave is complete");
}

function researchReady(state: WikiLeadRunState): boolean {
  const research = state.delegates.batches.flatMap((batch) => batch.tasks).filter((task) => task.task.role === "research");
  const discoveryAssignments = new Set(research
    .filter((task) => task.task.role === "research" && task.task.mode === "discovery")
    .flatMap((task) => task.task.role === "research" ? task.task.assignmentIds : []));
  const completedAssignments = new Set(research
    .filter((task) => task.phase === "terminal")
    .flatMap((task) => task.receipt?.completedAssignmentIds ?? []));
  return [...discoveryAssignments].every((id) => completedAssignments.has(id))
    && wikiOpenResearchBlockerIds(research.map(researchBlockerTask)).length === 0;
}

function researchBlockerTask(task: WikiTaskRuntimeState["batches"][number]["tasks"][number]) {
  const base = { id: task.task.id, role: task.task.role, phase: task.phase, ...(task.receipt ? { receipt: task.receipt } : {}) };
  return task.task.role === "research" ? { ...base, mode: task.task.mode, resolvesIds: task.task.resolvesIds } : base;
}

function taskRole(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).role === "string"
    ? (value as Record<string, unknown>).role as string
    : undefined;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

function parseAcceptedReview(value: unknown): AcceptedReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid accepted Wiki review");
  const raw = value as Record<string, unknown>;
  const result = parseWikiReviewResult(Object.fromEntries(Object.entries(raw).filter(([key]) => ["verdict", "reviewedPaths", "findings", "profileCoverage"].includes(key))));
  const basis = parseWikiReviewBasis(raw.basis);
  if (Object.keys(raw).some((key) => !["verdict", "reviewedPaths", "findings", "profileCoverage", "contractId", "contractDigest", "basis"].includes(key))
    || typeof raw.contractId !== "string" || typeof raw.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.contractDigest)
    || !sameStringSet(basis.paths, result.reviewedPaths)) throw new Error("Invalid accepted Wiki review");
  return { ...result, contractId: raw.contractId, contractDigest: raw.contractDigest, basis };
}

function parseDelegateState(value: unknown): WikiTaskRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { batches?: unknown }).batches)) throw new Error("Invalid Wiki delegate runtime state");
  if (Object.keys(value).some((key) => key !== "batches")) throw new Error("Invalid Wiki delegate runtime state");
  const raw = value as { batches: unknown[] };
  const batchIds = new Set<number>();
  const batches = raw.batches.map((entry, batchIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Wiki delegate batch state");
    const batch = entry as { batchId?: unknown; tasks?: unknown };
    if (Object.keys(batch).some((key) => key !== "batchId" && key !== "tasks")) throw new Error("Invalid Wiki delegate batch state");
    if (!Number.isSafeInteger(batch.batchId) || batch.batchId !== batchIndex + 1 || batchIds.has(batch.batchId as number) || !Array.isArray(batch.tasks) || batch.tasks.length === 0) throw new Error("Invalid Wiki delegate batch state");
    batchIds.add(batch.batchId as number);
    const taskIds = new Set<string>();
    return { batchId: batch.batchId as number, tasks: batch.tasks.map((taskValue) => {
      if (!taskValue || typeof taskValue !== "object" || Array.isArray(taskValue)) throw new Error("Invalid Wiki delegate task state");
      const task = taskValue as Record<string, unknown>;
      if (Object.keys(task).some((key) => !["task", "phase", "attempt", "collected", "pause", "partial", "sessionFile", "receipt"].includes(key))) throw new Error("Invalid Wiki delegate task state");
      const contract = parseWikiDelegateContract(task.task);
      if (taskIds.has(contract.id)) throw new Error("Duplicate Wiki delegate task state");
      taskIds.add(contract.id);
      if (contract.batchId !== batch.batchId || !["queued", "running", "paused", "terminal"].includes(String(task.phase))
        || !Number.isSafeInteger(task.attempt) || (task.attempt as number) < 0 || typeof task.collected !== "boolean") throw new Error("Invalid Wiki delegate task state");
      const receipt = task.receipt === undefined ? undefined : parseWikiDelegateReceipt(task.receipt);
      const pause = task.pause === undefined ? undefined : parseWikiDelegateError(task.pause);
      const partial = task.partial === undefined ? undefined : parseTaskPartial(task.partial);
      if ((task.phase === "queued" && task.attempt !== 0) || (task.phase !== "queued" && (task.attempt as number) < 1)
        || (task.phase === "terminal") !== Boolean(receipt) || task.phase !== "paused" && pause || task.phase !== "terminal" && task.collected
        || partial && task.phase !== "running" && task.phase !== "paused"
        || pause && pause.code !== "quota" && pause.code !== "usage_limit"
        || task.sessionFile !== undefined && (typeof task.sessionFile !== "string" || !task.sessionFile)
        || receipt && (receipt.id !== contract.id || receipt.role !== contract.role || receipt.attempts !== task.attempt
          || receipt.contractId !== contract.contractId || receipt.contractDigest !== contract.contractDigest)) throw new Error("Invalid Wiki delegate task transition state");
      return {
        task: contract,
        phase: task.phase as "queued" | "running" | "paused" | "terminal",
        attempt: task.attempt as number,
        collected: task.collected,
        ...(typeof task.sessionFile === "string" && task.sessionFile ? { sessionFile: task.sessionFile } : {}),
        ...(receipt ? { receipt } : {}),
        ...(pause ? { pause } : {}),
        ...(partial ? { partial } : {}),
      };
    }) };
  });
  return { batches };
}

function parseTaskPartial(value: unknown): NonNullable<WikiTaskRuntimeState["batches"][number]["tasks"][number]["partial"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki delegate partial state");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["outputs", "coverage", "gaps"].includes(key)) || !Array.isArray(raw.outputs)
    || !Array.isArray(raw.coverage) || raw.coverage.some((item) => typeof item !== "string" || !item)
    || !Array.isArray(raw.gaps)) throw new Error("Invalid Wiki delegate partial state");
  return { outputs: raw.outputs.map(parseWikiArtifactRef), coverage: [...raw.coverage] as string[], gaps: raw.gaps.map(parseWikiDelegateGap) };
}

async function readTransaction(location: string, runId: string): Promise<CandidateTransaction | undefined> {
  try {
    const raw = JSON.parse(await readFile(location, "utf8")) as CandidateTransaction;
    if (raw.version !== WIKI_FORMAT) throw new UnsupportedWikiRunVersionError(`runs/${runId}/candidate-transaction.json`, raw.version);
    if (raw.runId !== runId || typeof raw.path !== "string" || typeof raw.staged !== "string"
      || raw.oldDigest !== null && !/^[a-f0-9]{64}$/.test(raw.oldDigest) || !/^[a-f0-9]{64}$/.test(raw.newDigest)) throw new Error("Invalid Wiki candidate transaction");
    return { ...raw, nextState: parseState(raw.nextState, runId, false) };
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function readPublicationTransaction(location: string, runId: string): Promise<PublicationFinalizationTransaction | undefined> {
  try {
    const raw = JSON.parse(await readFile(location, "utf8")) as Record<string, unknown>;
    const allowed = ["version", "runId", "candidateRevision", "policyDigest", "preTreeDigest", "publicationAt", "requiredPaths", "requiredProfileCoverage", "preimageRoot"];
    if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("Invalid Wiki publication finalization transaction");
    if (raw.version !== WIKI_FORMAT) throw new UnsupportedWikiRunVersionError(`runs/${runId}/publication-finalization.json`, raw.version);
    if (raw.runId !== runId
      || !Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0
      || typeof raw.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.policyDigest)
      || typeof raw.preTreeDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.preTreeDigest)
      || typeof raw.publicationAt !== "string" || typeof raw.preimageRoot !== "string"
      || !Array.isArray(raw.requiredPaths) || raw.requiredPaths.some((value) => typeof value !== "string")
      || !Array.isArray(raw.requiredProfileCoverage) || raw.requiredProfileCoverage.some((value) => typeof value !== "string")) {
      throw new Error("Invalid Wiki publication finalization transaction");
    }
    return raw as unknown as PublicationFinalizationTransaction;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function copySafeTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new WikiCandidateCorruptionError(`Candidate Wiki contains a symbolic link: ${from}`);
    if (entry.isDirectory()) await copySafeTree(from, to);
    else if (entry.isFile()) await writeDurableNew(to, await readFile(from, "utf8"));
    else throw new WikiCandidateCorruptionError(`Candidate Wiki contains a non-regular entry: ${from}`);
  }
  await syncDirectory(target);
}

async function restoreSafeTree(preimage: string, candidate: string, expectedDigest: string): Promise<void> {
  if (await digestWikiTree(preimage) !== expectedDigest) throw new WikiCandidateCorruptionError("Publication preimage digest mismatch");
  await rm(candidate, { recursive: true, force: true });
  await copySafeTree(preimage, candidate);
  if (await digestWikiTree(candidate) !== expectedDigest) throw new WikiCandidateCorruptionError("Restored publication preimage digest mismatch");
}

async function writeDurableNew(location: string, content: string): Promise<void> {
  const file = await open(location, "wx");
  try { await file.writeFile(content, "utf8"); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(path.dirname(location));
}

async function fileDigest(location: string): Promise<string | null> {
  try { await assertRegularOrMissing(location); return hash(await readFile(location)); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

async function assertRegularOrMissing(location: string): Promise<void> {
  try { if (!(await lstat(location)).isFile()) throw new WikiCandidateCorruptionError(`Candidate path must be a regular file: ${location}`); }
  catch (error) { if (!isMissing(error)) throw error; }
}

function sameBasis(basis: WikiReviewBasis, state: Pick<WikiLeadRunState, "candidateRevision" | "policyDigest">, treeDigest: string): boolean {
  return basis.candidateRevision === state.candidateRevision && basis.policyDigest === state.policyDigest && basis.treeDigest === treeDigest;
}
function assertReceiptForContract(receipt: WikiDelegateReceipt, contract: WikiDelegateContract, attempt: number, runId: string): void {
  const mismatches = [
    receipt.id !== contract.id && "task id",
    receipt.role !== contract.role && "role",
    receipt.attempts !== attempt && "attempt",
    receipt.contractId !== contract.contractId && "contract id",
    receipt.contractDigest !== contract.contractDigest && "contract digest",
    receipt.outputs.some((output) => output.runId !== runId || output.nodeId !== contract.contractId || output.attempt !== attempt) && "artifact ownership",
  ].filter(Boolean);
  if (mismatches.length) throw new Error(`Delegate receipt does not match durable contract ${contract.contractId}: ${mismatches.join(", ")}`);
  if (contract.role === "review" && receipt.review && !sameStringSet(receipt.review.reviewedPaths, contract.reviewPaths)) {
    throw new Error(`Review receipt paths do not match durable contract ${contract.contractId}`);
  }
  if (contract.role === "research") {
    const assignments = new Set(contract.assignmentIds);
    const completed = receipt.completedAssignmentIds ?? [];
    if (completed.some((id) => !assignments.has(id))) {
      throw new Error(`Research receipt completedAssignmentIds do not match durable contract ${contract.contractId}`);
    }
    if (receipt.status === "complete" && (completed.length !== contract.assignmentIds.length
      || contract.assignmentIds.some((id) => !completed.includes(id)))) {
      throw new Error(`Research complete receipt completedAssignmentIds must exactly match durable contract ${contract.contractId}`);
    }
    const sourceScopes = new Set(contract.sourceScopeIds);
    for (const followup of receipt.followups ?? []) {
      if (followup.sourceScopeIds.some((id) => !sourceScopes.has(id))) {
        throw new Error(`Research receipt followup sourceScopeIds do not match durable contract ${contract.contractId}`);
      }
    }
  }
}
function replaceBatch(state: WikiLeadRunState, index: number, batch: WikiTaskRuntimeState["batches"][number]): WikiLeadRunState {
  const batches = [...state.delegates.batches];
  batches[index] = batch;
  return { ...state, delegates: { batches } };
}

function boardInput(state: WikiLeadRunState): WikiBoardProjectionInput {
  return {
    runId: state.runId,
    specRevision: state.specRevision,
    candidateRevision: state.candidateRevision,
    ...(state.taxonomy ? { taxonomy: state.taxonomy } : {}),
    compactionObserved: state.compactionObserved,
    spec: state.spec,
    reviews: state.reviews.map((review) => ({ verdict: review.verdict, reviewedPaths: review.reviewedPaths })),
    delegates: {
      batches: state.delegates.batches.map((batch) => ({
        batchId: batch.batchId,
        tasks: batch.tasks.map((task) => ({
          id: task.task.id,
          role: task.task.role,
          phase: task.phase,
          ...(task.task.role === "research" ? {
            mode: task.task.mode,
            sourceScopeIds: task.task.sourceScopeIds,
            contextRefs: task.task.contextRefs,
            assignmentIds: task.task.assignmentIds,
            domainScopeIds: task.task.domainScopeIds,
            lensScopeIds: task.task.lensScopeIds,
            resolvesIds: task.task.resolvesIds,
          } : {}),
          ...(task.task.role === "write" ? { writePaths: task.task.writePaths } : {}),
          ...(task.task.role === "review" ? { reviewPaths: task.task.reviewPaths } : {}),
          ...(task.receipt ? { receipt: {
            status: task.receipt.status,
            ...(task.receipt.error ? { error: { code: task.receipt.error.code } } : {}),
            ...(task.receipt.outputs ? { outputs: task.receipt.outputs } : {}),
            ...(task.receipt.completedAssignmentIds ? { completedAssignmentIds: task.receipt.completedAssignmentIds } : {}),
            ...(task.receipt.needsFollowup !== undefined ? { needsFollowup: task.receipt.needsFollowup } : {}),
            ...(task.receipt.followups ? { followups: task.receipt.followups } : {}),
            ...(task.receipt.coverage ? { coverage: task.receipt.coverage } : {}),
            ...(task.receipt.gaps ? { gaps: task.receipt.gaps } : {}),
          } } : {}),
        })),
      })),
    },
  };
}
function dispatchTaskInput(value: unknown): { id?: string; role?: string; instruction?: string; cluster?: string; writePaths?: readonly string[]; reviewPaths?: readonly string[]; sourceScopeIds?: readonly string[]; contextRefs?: readonly string[]; mode?: "discovery" | "supplement"; domainScopeIds?: readonly string[]; lensScopeIds?: readonly string[]; resolvesIds?: readonly string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const task = value as Record<string, unknown>;
  const id = typeof task.id === "string" ? task.id : undefined;
  const role = typeof task.role === "string" ? task.role : undefined;
  return {
    ...(typeof task.id === "string" ? { id: task.id } : {}),
    ...(typeof task.role === "string" ? { role: task.role } : {}),
    ...(typeof task.instruction === "string" ? { instruction: task.instruction } : {}),
    ...(typeof task.cluster === "string" ? { cluster: task.cluster } : {}),
    ...(Array.isArray(task.writePaths) ? { writePaths: task.writePaths.filter((path): path is string => typeof path === "string") } : {}),
    ...(Array.isArray(task.reviewPaths) ? { reviewPaths: task.reviewPaths.filter((path): path is string => typeof path === "string") } : {}),
    ...(Array.isArray(task.sourceScopeIds) ? { sourceScopeIds: task.sourceScopeIds.filter((path): path is string => typeof path === "string") } : {}),
    ...(Array.isArray(task.contextRefs) ? { contextRefs: task.contextRefs.filter((path): path is string => typeof path === "string") } : {}),
    ...(role === "research" ? { mode: task.mode === "supplement" ? "supplement" : "discovery", domainScopeIds: Array.isArray(task.domainScopeIds) ? task.domainScopeIds.filter((value): value is string => typeof value === "string") : [], lensScopeIds: Array.isArray(task.lensScopeIds) ? task.lensScopeIds.filter((value): value is string => typeof value === "string") : [], resolvesIds: Array.isArray(task.resolvesIds) ? task.resolvesIds.filter((value): value is string => typeof value === "string") : [] } : {}),
  };
}

function expandDispatchTask(value: unknown, spec: WikiSpec | undefined, existingResearchTasks: readonly { id: string; mode: "discovery" | "supplement"; assignmentIds: readonly string[]; resolvesIds: readonly string[]; receipt?: { status: "complete" | "incomplete" | "failed"; error?: { code?: string }; gaps?: readonly unknown[]; followups?: readonly { id: string }[] } }[] = [], hostAssignmentId?: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const task = { ...(value as Record<string, unknown>) };
  const cluster = typeof task.cluster === "string" ? task.cluster : undefined;
  delete task.cluster;
  if (!Array.isArray(task.sourceScopeIds)) task.sourceScopeIds = [];
  if (!Array.isArray(task.contextRefs)) task.contextRefs = [];
  if (task.role === "research") {
    if (task.mode !== "discovery" && task.mode !== "supplement") task.mode = "discovery";
    const resolvesIds = Array.isArray(task.resolvesIds) ? task.resolvesIds.filter((value): value is string => typeof value === "string") : [];
    const blockerAssignments = new Map<string, readonly string[]>();
    for (const prior of existingResearchTasks) {
      const receipt = prior.receipt;
      const blockerIds = [
        ...(receipt?.error?.code && !(receipt.gaps?.length || receipt.followups?.length) ? [`failure:${prior.id}:${receipt.error.code}`] : []),
        ...(receipt?.gaps ?? []).map((_gap, index) => `gap:${prior.id}:${index + 1}`),
        ...(receipt?.followups ?? []).map((followup) => followup.id),
      ];
      for (const blockerId of blockerIds) blockerAssignments.set(blockerId, prior.assignmentIds);
    }
    task.assignmentIds = task.mode === "supplement"
      ? [...new Set(resolvesIds.flatMap((blockerId) => blockerAssignments.get(blockerId) ?? []))]
      : (hostAssignmentId ? [hostAssignmentId] : []);
    if (!Array.isArray(task.domainScopeIds)) task.domainScopeIds = [];
    if (!Array.isArray(task.lensScopeIds)) task.lensScopeIds = [];
    task.resolvesIds = resolvesIds;
    return task;
  }
  if (task.role !== "write" && task.role !== "review") return task;
  if (!cluster?.trim()) return task;
  if (!spec) throw new Error(`Submit an accepted WikiSpec before delegating ${task.role} tasks`);
  const paths = wikiSpecClusterPaths(spec, cluster).map((page) => `wiki/${page}`);
  if (!paths.length) return { ...task, cluster };
  if (task.role === "write") return { ...task, writePaths: paths };
  return { ...task, reviewPaths: paths };
}

function pendingWritePaths(state: WikiLeadRunState): string[] {
  return state.delegates.batches.flatMap((batch) => batch.tasks
    .filter((task) => task.task.role === "write" && task.phase !== "terminal")
    .flatMap((task) => task.task.writePaths ?? []));
}
function knownContextRefs(state: WikiLeadRunState): string[] {
  return state.delegates.batches.flatMap((batch) => batch.tasks.flatMap((task) => (task.receipt?.outputs ?? []).map((output) => output.nodeId)));
}
function delegatedTaskCount(state: WikiLeadRunState): number {
  return state.delegates.batches.reduce((sum, batch) => sum + batch.tasks.length, 0);
}
function stripWikiPrefix(value: string): string { if (!value.startsWith("wiki/")) throw new Error(`Wiki path must start with wiki/: ${value}`); return value.slice(5); }
function candidateDirectory(workspace: string, candidate: string): string { return path.relative(workspace, candidate).split(path.sep).join("/"); }
function serializeState(state: WikiLeadRunState): string {
  const body = JSON.parse(JSON.stringify(state)) as WikiLeadRunState & { stateDigest?: string };
  delete body.stateDigest;
  return `${JSON.stringify({ ...body, stateDigest: hash(stableStringify(body)) }, null, 2)}\n`;
}
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isMissing(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT"); }

async function acquireRunLease(location: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(location, "wx");
      try { await handle.writeFile(`${process.pid}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(path.dirname(location));
      return async () => { await rm(location, { force: true }); await syncDirectory(path.dirname(location)); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(await readFile(location, "utf8").catch(() => ""), 10);
      if (Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid && !processExists(owner)) {
        await rm(location, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Wiki Lead run lease: ${location}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
