import {
  sameWikiCluster,
  wikiSpecClusterId,
  wikiSpecClusterPaths,
  wikiSpecClusters,
  wikiSpecPagePaths,
  wikiSpecRelativePath,
  type WikiSpec,
} from "./spec.js";

export type WikiLogicalWave = "discovery" | "supplement" | "write" | "review";

export interface WikiDispatchTaskInput {
  id?: string;
  role?: string;
  instruction?: string;
  cluster?: string;
  writePaths?: readonly string[];
  reviewPaths?: readonly string[];
  contextRefs?: readonly string[];
  mode?: "discovery" | "supplement";
  assignmentIds?: readonly string[];
  domainScopeIds?: readonly string[];
  lensScopeIds?: readonly string[];
  resolvesIds?: readonly string[];
}
export interface WikiDispatchInput {
  tasks: readonly WikiDispatchTaskInput[];
  spec?: WikiSpec;
  pendingWritePaths?: readonly string[];
  knownContextRefs?: readonly string[] | ReadonlySet<string>;
  delegatedTasks?: number;
  delegateBatches?: number;
  maxDelegatedTasks?: number;
  existingResearchTasks?: readonly {
    id: string;
    mode: "discovery" | "supplement";
    assignmentIds: readonly string[];
    resolvesIds: readonly string[];
  }[];
  knownResearchBlockerIds?: readonly string[];
}

/** Reject an illegal delegate batch before any contract is created. */
export function assertDispatchable(input: WikiDispatchInput): void {
  const tasks = input.tasks;
  if (!tasks.length) throw new Error("Delegation requires at least one task");

  const ids = new Set<string>();
  for (const task of tasks) {
    const id = task.id ?? "";
    if (ids.has(id)) throw new Error(`Duplicate delegate task id: ${id}`);
    ids.add(id);
    if (typeof task.instruction !== "string" || !task.instruction.trim()) {
      throw new Error(`Delegate task ${id || "(missing)"} has an empty instruction`);
    }
  }

  const hasWrite = tasks.some((task) => task.role === "write");
  const hasReview = tasks.some((task) => task.role === "review");
  const hasDiscovery = tasks.some((task) => task.role === "research" && (task.mode ?? "discovery") === "discovery");
  const hasSupplement = tasks.some((task) => task.role === "research" && task.mode === "supplement");
  if (hasDiscovery && (hasSupplement || hasWrite || hasReview)) throw new Error("Discovery research may not mix with another research wave, write, or review tasks");
  if (hasSupplement && (hasWrite || hasReview)) throw new Error("Supplement research may not mix with write or review tasks");
  if (hasWrite && hasReview) throw new Error("A delegate batch may not mix write and review tasks");

  const pendingWritePaths = [...(input.pendingWritePaths ?? [])].map(wikiSpecRelativePath);
  if (hasReview && pendingWritePaths.length) {
    throw new Error("Wiki review is blocked while delegated Wiki writes are pending");
  }

  if (input.maxDelegatedTasks !== undefined
    && (!Number.isSafeInteger(input.maxDelegatedTasks) || input.maxDelegatedTasks < 0)) {
    throw new Error("maxDelegatedTasks must be a non-negative safe integer");
  }
  if (input.maxDelegatedTasks !== undefined && (input.delegatedTasks ?? 0) + tasks.length > input.maxDelegatedTasks) {
    throw new Error(`Delegated task limit exhausted (${input.maxDelegatedTasks}); ${Math.max(0, input.maxDelegatedTasks - (input.delegatedTasks ?? 0))} task slots remain`);
  }

  const spec = input.spec;
  const known = input.knownContextRefs instanceof Set ? input.knownContextRefs : new Set(input.knownContextRefs ?? []);
  const batchWritePaths = new Set<string>();
  const pending = new Set(pendingWritePaths);
  const priorResearch = input.existingResearchTasks ?? [];
  const priorAssignments = new Set(priorResearch.flatMap((task) => task.assignmentIds));
  const blockerIds = new Set(input.knownResearchBlockerIds ?? []);
  for (const task of tasks) {
    if (task.role !== "research") continue;
    const mode = task.mode ?? "discovery";
    const assignments = [...(task.assignmentIds ?? [])];
    if (!assignments.length) throw new Error(`Research task ${task.id} requires assignmentIds`);
    if (new Set(assignments).size !== assignments.length) throw new Error(`Research task ${task.id} assignmentIds must be unique`);
    const resolves = [...(task.resolvesIds ?? [])];
    if (mode === "supplement") {
      if (!resolves.length) throw new Error(`Supplement research task ${task.id} must resolve a gap, conflict, or failure ID`);
      for (const blocker of resolves) if (!blockerIds.has(blocker)) throw new Error(`Supplement research task ${task.id} references unknown blocker: ${blocker}`);
      for (const blocker of resolves) blockerIds.delete(blocker);
    } else if (resolves.length) {
      throw new Error(`Discovery research task ${task.id} cannot resolve blocker IDs`);
    }
    const duplicate = assignments.filter((assignment) => priorAssignments.has(assignment));
    if (duplicate.length && !resolves.length) {
      throw new Error(`Research assignment already covered without a blocker: ${duplicate.join(", ")}`);
    }
    for (const assignment of assignments) priorAssignments.add(assignment);
  }

  for (const task of tasks) {
    if (task.role === "write" || task.role === "review") {
      if (!spec) throw new Error(`Submit an accepted WikiSpec before delegating ${task.role} tasks`);
      const cluster = dispatchCluster(task, spec);
      const clusterPages = wikiSpecClusterPaths(spec, cluster);

      if (task.role === "write") {
        const overlapPages = task.cluster !== undefined && String(task.cluster).trim()
          ? clusterPages
          : (task.writePaths ?? []).map(wikiSpecRelativePath);
        for (const page of overlapPages) {
          const key = wikiSpecRelativePath(page);
          if (batchWritePaths.has(key)) throw new Error(`Write path overlaps another task in this batch: ${page}`);
          if (pending.has(key)) throw new Error(`Write path overlaps an existing non-terminal write: ${page}`);
          batchWritePaths.add(key);
        }
      }
    }

    for (const ref of task.contextRefs ?? []) {
      if (!known.has(ref)) throw new Error(`Delegate task ${task.id} requests unknown context artifact: ${ref}`);
    }
  }
}

export function wikiDispatchWave(task: Pick<WikiDispatchTaskInput, "role" | "mode">): WikiLogicalWave {
  if (task.role === "write") return "write";
  if (task.role === "review") return "review";
  return task.mode === "supplement" ? "supplement" : "discovery";
}

/** Resolve a write/review cluster id from the Lead-facing cluster field, or from internal path lists. */
function dispatchCluster(task: WikiDispatchTaskInput, spec: WikiSpec): string {
  const labeled = typeof task.cluster === "string" ? task.cluster.trim() : "";
  if (labeled) {
    if (!wikiSpecClusters(spec).includes(labeled) || !wikiSpecClusterPaths(spec, labeled).length) {
      throw new Error(`Unknown Wiki cluster: ${labeled}`);
    }
    return labeled;
  }

  const paths = task.role === "write" ? task.writePaths ?? [] : task.reviewPaths ?? [];
  if (!paths.length) throw new Error(`Delegate ${task.role} task ${task.id} requires a cluster`);
  const clusterId = wikiSpecClusterId(paths[0]);
  const declared = new Set(wikiSpecPagePaths(spec).flatMap((page) => [page, `wiki/${page}`]));
  if (!clusterId || !sameWikiCluster(paths) || !wikiSpecClusters(spec).includes(clusterId) || !wikiSpecClusterPaths(spec, clusterId).length) {
    throw new Error(`Unknown Wiki cluster: ${clusterId ?? paths[0]}`);
  }
  for (const page of paths) {
    if (!declared.has(page)) throw new Error(`Unknown Wiki cluster: ${page}`);
  }
  return clusterId;
}
