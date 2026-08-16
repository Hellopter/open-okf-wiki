import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { syncDirectory, writeText } from "./files.js";
import { assertContainedAbsolutePath } from "./path-policy.js";
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
  type WikiDelegateTask,
  type WikiReviewBasis,
} from "./delegate-contracts.js";
import type { WikiPinnedSourcePlan, WikiTaskRuntimeState } from "./runtime-types.js";
import type { WikiDelegateBatchSnapshot } from "./delegate-contracts.js";
import { finalizeWiki, materializeValidatedWikiIndexes, type WikiFinalizeFaultPoint } from "./wiki-finalize.js";
import { parseWikiSpec, wikiSpecPagePaths, type WikiSpec } from "./wiki-spec.js";
import { canonicalizeWikiPageContent, formatIssue, resolvePinnedWikiRoots, validateWikiPageContent, type ResolvedWikiRoots } from "./wiki-validate.js";
import { parseWikiReviewResult, type WikiReviewResult } from "./delegate-contracts.js";
import {
  digestWikiTree,
  issueWikiPublicationSeal,
  type WikiPublicationSeal,
} from "./wiki-publication-seal.js";
import { sameStringSet, stableStringify } from "./util.js";
import { projectWikiBoard, renderWikiBoard, wikiLeadMayWrite, type WikiBoardProjectionInput } from "./wiki-board.js";
import { assertDispatchable } from "./wiki-dispatch.js";

const STATE_VERSION = 2 as const;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface AcceptedReview extends WikiReviewResult {
  contractId: string;
  contractDigest: string;
  basis: WikiReviewBasis;
}

interface WikiLeadRunState {
  version: typeof STATE_VERSION;
  runId: string;
  candidateRevision: number;
  specRevision: number;
  policyDigest: string;
  compactionObserved: boolean;
  spec?: WikiSpec;
  reviews: AcceptedReview[];
  delegates: WikiTaskRuntimeState;
}

export interface WikiLeadSpecRecord {
  revision: number;
  spec: WikiSpec;
}

interface CandidateTransaction {
  version: 1;
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
  executionFence: { runStateFile: string; attempt: number; executionToken: string };
  sourcePlan?: WikiPinnedSourcePlan;
  language?: "zh" | "en";
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
  version: 1;
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
    private readonly executionFence: WikiLeadRunOptions["executionFence"],
    private readonly pinnedRoots: ResolvedWikiRoots | undefined,
    private state: WikiLeadRunState,
  ) {}

  static async open(options: WikiLeadRunOptions): Promise<WikiLeadRun> {
    if (!SAFE_RUN_ID.test(options.runId)) throw new Error("Invalid Wiki Lead run id");
    await assertExecutionFenceValue(options.executionFence, options.runId);
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
    let state = await readState(stateFile, options.runId);
    state ??= emptyState(options.runId, policyDigest);
    const pinnedRoots = options.sourcePlan
      ? await resolvePinnedWikiRoots(options.sourcePlan, options.language ?? "en", candidateDirectory(workspace, candidate))
      : undefined;
    const subject = new WikiLeadRun(workspace, options.runId, candidate, stateFile, journalFile, lockFile, options.requiredSections ?? [], options.fault, options.finalizeFault, options.executionFence, pinnedRoots, state);
    await subject.serial(async () => {
      await subject.recover();
      if (subject.state.policyDigest !== policyDigest) {
        subject.state = { ...subject.state, policyDigest, candidateRevision: subject.state.candidateRevision + 1, reviews: [] };
        await subject.persist();
      } else if (!(await fileExists(stateFile))) {
        await subject.persist();
      }
    });
    return subject;
  }

  get specRecord(): WikiLeadSpecRecord | undefined {
    return this.state.spec ? { revision: this.state.specRevision, spec: structuredClone(this.state.spec) } : undefined;
  }

  get compactionObserved(): boolean { return this.state.compactionObserved; }

  get taskRuntimeState(): WikiTaskRuntimeState { return structuredClone(this.state.delegates); }

  async saveSpec(specValue: unknown, expectedRevision = this.state.specRevision): Promise<WikiLeadSpecRecord> {
    return await this.serial(async () => {
      await this.recover();
      if (expectedRevision !== this.state.specRevision) throw new Error(`WikiSpec revision conflict: expected ${expectedRevision}, found ${this.state.specRevision}`);
      const spec = parseWikiSpec(specValue);
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
      await this.persist();
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
      const transaction: CandidateTransaction = { version: 1, runId: this.runId, path: relative, staged, oldDigest, newDigest, nextState };
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
  async queueDelegateBatch(values: readonly unknown[]): Promise<{ batchId: number; contracts: WikiDelegateContract[] }> {
    return await this.serial(async () => {
      await this.recover();
      const parsed = values.map(parseWikiDelegateTask);
      assertDispatchable({
        tasks: parsed,
        spec: this.state.spec,
        pendingWritePaths: pendingWritePaths(this.state),
        knownContextRefs: knownContextRefs(this.state),
        delegatedTasks: delegatedTaskCount(this.state),
        delegateBatches: this.state.delegates.batches.length,
      });
      const batchId = this.state.delegates.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId + 1), 1);
      if (!Number.isSafeInteger(batchId)) throw new Error("Delegate batch identity is exhausted");
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

  async assertPublishable(requiredPaths: readonly string[], requiredProfileCoverage: readonly string[]): Promise<void> {
    await this.serial(async () => {
      await this.recover();
      await this.assertPublishableAtTree(requiredPaths, requiredProfileCoverage, await digestWikiTree(this.candidateWikiRoot));
    });
  }

  async sealForPublication(input: {
    requiredPaths?: readonly string[];
    requiredProfileCoverage: readonly string[];
    publicationAt?: string;
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
        executionToken: this.executionFence.executionToken,
        candidateRoot: this.candidateWikiRoot,
        pages: wikiSpecPagePaths(this.requireSpec()),
        spec: this.requireSpec(),
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
    return { version: 1, candidateRevision: this.state.candidateRevision, treeDigest, policyDigest: this.state.policyDigest, paths: unique };
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
      version: 1,
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

  private async persist(): Promise<void> { await this.writeState(this.state); }

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
        await this.assertExecutionFence();
        result = await operation();
      }
      finally { await release(); }
    });
    this.chain = next.catch(() => {});
    await next;
    return result;
  }

  private async assertExecutionFence(): Promise<void> {
    await assertExecutionFenceValue(this.executionFence, this.runId);
  }
}

async function assertExecutionFenceValue(fence: NonNullable<WikiLeadRunOptions["executionFence"]>, runId: string): Promise<void> {
  if (!fence || !Number.isSafeInteger(fence.attempt) || fence.attempt < 1 || typeof fence.executionToken !== "string" || !fence.executionToken.trim()) {
    throw new WikiLeadExecutionFencedError("Invalid Wiki Lead execution fence");
  }
  const raw = JSON.parse(await readFile(fence.runStateFile, "utf8")) as Record<string, unknown>;
  if (raw.version !== 2 || raw.id !== runId || raw.status !== "running" || raw.attempt !== fence.attempt
    || raw.executionToken !== fence.executionToken) {
    throw new WikiLeadExecutionFencedError(`Wiki Lead execution ${fence.attempt}/${fence.executionToken} is no longer active`);
  }
}

export class WikiCandidateCorruptionError extends Error {
  constructor(message: string) { super(message); this.name = "WikiCandidateCorruptionError"; }
}

export class WikiLeadExecutionFencedError extends Error {
  constructor(message: string) { super(message); this.name = "WikiLeadExecutionFencedError"; }
}

export async function sealWikiLeadRunForPublication(
  options: WikiLeadRunOptions & {
    requiredProfileCoverage: readonly string[];
    publicationAt?: string;
  },
): Promise<WikiPublicationSeal> {
  const run = await WikiLeadRun.open(options);
  return await run.sealForPublication(options);
}

function emptyState(runId: string, policyDigest: string): WikiLeadRunState {
  return { version: STATE_VERSION, runId, candidateRevision: 0, specRevision: 0, policyDigest, compactionObserved: false, reviews: [], delegates: { batches: [] } };
}

async function readState(location: string, runId: string): Promise<WikiLeadRunState | undefined> {
  try { return parseState(JSON.parse(await readFile(location, "utf8")), runId); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function parseState(value: unknown, runId: string, requireDigest = true): WikiLeadRunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  const raw = value as unknown as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["version", "runId", "candidateRevision", "specRevision", "policyDigest", "compactionObserved", "spec", "reviews", "delegates", "stateDigest"].includes(key))) throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  const { stateDigest, ...body } = raw;
  if (requireDigest && (typeof stateDigest !== "string" || stateDigest !== hash(stableStringify(body)))) throw new Error(`Wiki Lead run state integrity check failed for ${runId}`);
  if (raw.version !== STATE_VERSION || raw.runId !== runId || !Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0
    || !Number.isSafeInteger(raw.specRevision) || (raw.specRevision as number) < 0 || typeof raw.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.policyDigest)
    || typeof raw.compactionObserved !== "boolean" || !Array.isArray(raw.reviews) || !raw.delegates
    || (raw.spec === undefined) !== (raw.specRevision === 0)) throw new Error(`Invalid Wiki Lead run state for ${runId}`);
  return {
    version: STATE_VERSION,
    runId,
    candidateRevision: raw.candidateRevision as number,
    specRevision: raw.specRevision as number,
    policyDigest: raw.policyDigest as string,
    compactionObserved: raw.compactionObserved,
    ...(raw.spec ? { spec: parseWikiSpec(raw.spec) } : {}),
    reviews: raw.reviews.map(parseAcceptedReview),
    delegates: parseDelegateState(raw.delegates),
  };
}

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
    if (raw.version !== 1 || raw.runId !== runId || typeof raw.path !== "string" || typeof raw.staged !== "string"
      || raw.oldDigest !== null && !/^[a-f0-9]{64}$/.test(raw.oldDigest) || !/^[a-f0-9]{64}$/.test(raw.newDigest)) throw new Error("Invalid Wiki candidate transaction");
    return { ...raw, nextState: parseState(raw.nextState, runId, false) };
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function readPublicationTransaction(location: string, runId: string): Promise<PublicationFinalizationTransaction | undefined> {
  try {
    const raw = JSON.parse(await readFile(location, "utf8")) as Record<string, unknown>;
    const allowed = ["version", "runId", "candidateRevision", "policyDigest", "preTreeDigest", "publicationAt", "requiredPaths", "requiredProfileCoverage", "preimageRoot"];
    if (Object.keys(raw).some((key) => !allowed.includes(key)) || raw.version !== 1 || raw.runId !== runId
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
          ...(task.task.role === "write" ? { writePaths: task.task.writePaths } : {}),
          ...(task.task.role === "review" ? { reviewPaths: task.task.reviewPaths } : {}),
          ...(task.receipt ? { receipt: { status: task.receipt.status, ...(task.receipt.error ? { error: { code: task.receipt.error.code } } : {}) } } : {}),
        })),
      })),
    },
  };
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
async function fileExists(location: string): Promise<boolean> { try { await lstat(location); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }
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
