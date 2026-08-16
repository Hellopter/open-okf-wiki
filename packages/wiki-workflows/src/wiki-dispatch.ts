import { sameWikiCluster, wikiSpecPagePaths, wikiSpecRelativePath, type WikiSpec } from "./wiki-spec.js";

const FANOUT = { research: 4, write: 2, review: 2 } as const;

export interface WikiDispatchTaskInput {
  id?: string;
  role?: string;
  instruction?: string;
  writePaths?: readonly string[];
  reviewPaths?: readonly string[];
  contextRefs?: readonly string[];
}

export interface WikiDispatchInput {
  tasks: readonly WikiDispatchTaskInput[];
  spec?: WikiSpec;
  pendingWritePaths?: readonly string[];
  knownContextRefs?: readonly string[] | ReadonlySet<string>;
  delegatedTasks?: number;
  delegateBatches?: number;
  maxDelegatedTasks?: number;
  maxDelegateBatches?: number;
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
  if (hasWrite && hasReview) throw new Error("A delegate batch may not mix write and review tasks");

  const pendingWritePaths = [...(input.pendingWritePaths ?? [])].map(wikiSpecRelativePath);
  if (hasReview && pendingWritePaths.length) {
    throw new Error("Wiki review is blocked while delegated Wiki writes are pending");
  }

  const counts = { research: 0, write: 0, review: 0 };
  for (const task of tasks) {
    if (task.role === "research" || task.role === "write" || task.role === "review") counts[task.role] += 1;
  }
  for (const role of ["research", "write", "review"] as const) {
    if (counts[role] > FANOUT[role]) {
      throw new Error(`A delegate batch may include at most ${FANOUT[role]} ${role} tasks`);
    }
  }

  const delegatedTasks = input.delegatedTasks ?? 0;
  const delegateBatches = input.delegateBatches ?? 0;
  const maxDelegatedTasks = input.maxDelegatedTasks ?? Number.POSITIVE_INFINITY;
  const maxDelegateBatches = input.maxDelegateBatches ?? Number.POSITIVE_INFINITY;
  if (delegatedTasks + tasks.length > maxDelegatedTasks) {
    throw new Error(`Delegated task limit exhausted (${maxDelegatedTasks})`);
  }
  if (delegateBatches + 1 > maxDelegateBatches) {
    throw new Error(`Delegate batch limit exhausted (${maxDelegateBatches})`);
  }

  const spec = input.spec;
  const declared = new Set((spec ? wikiSpecPagePaths(spec) : []).flatMap((page) => [page, `wiki/${page}`]));
  const known = input.knownContextRefs instanceof Set ? input.knownContextRefs : new Set(input.knownContextRefs ?? []);
  const batchWritePaths = new Set<string>();
  const pending = new Set(pendingWritePaths);

  for (const task of tasks) {
    if (task.role === "write" || task.role === "review") {
      if (!spec) throw new Error(`Submit an accepted WikiSpec before delegating ${task.role} tasks`);
      const paths = task.role === "write" ? task.writePaths ?? [] : task.reviewPaths ?? [];
      if (!paths.length) throw new Error(`Delegate ${task.role} task ${task.id} requires paths`);
      for (const page of paths) {
        if (!declared.has(page)) {
          throw new Error(`Delegated ${task.role} path is not declared by the current WikiSpec: ${page}`);
        }
      }
      if (!sameWikiCluster(paths)) {
        throw new Error(`Delegated ${task.role} paths must belong to one Wiki cluster`);
      }
    }

    for (const ref of task.contextRefs ?? []) {
      if (!known.has(ref)) throw new Error(`Delegate task ${task.id} requests unknown context artifact: ${ref}`);
    }

    if (task.role === "write") {
      for (const page of task.writePaths ?? []) {
        const key = wikiSpecRelativePath(page);
        if (batchWritePaths.has(key)) throw new Error(`Write path overlaps another task in this batch: ${page}`);
        if (pending.has(key)) throw new Error(`Write path overlaps an existing non-terminal write: ${page}`);
        batchWritePaths.add(key);
      }
    }
  }
}

