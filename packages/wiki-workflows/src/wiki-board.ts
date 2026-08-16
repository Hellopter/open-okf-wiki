import { wikiSpecClusterId, wikiSpecClusterPaths, wikiSpecClusters, wikiSpecPages, wikiSpecRelativePath, type WikiSpec } from "./wiki-spec.js";

export type WikiBoardClusterStatus =
  | "unplanned"
  | "writing"
  | "reviewing"
  | "accepted"
  | "blocked";

export interface WikiBoardCluster {
  id: string;
  paths: string[];
  status: WikiBoardClusterStatus;
  terminalWriteOrReviewCount: number;
}

export interface WikiBoardTask {
  id: string;
  role: "research" | "write" | "review";
  paths: string[];
  phase: "queued" | "running" | "paused" | "terminal";
  receiptStatus?: "complete" | "incomplete" | "failed";
  errorCode?: string;
}

export interface WikiBoardModel {
  runId: string;
  specRevision: number;
  candidateRevision: number;
  compactionObserved: boolean;
  directWriteAllowed: boolean;
  clusters: WikiBoardCluster[];
  tasks: WikiBoardTask[];
  remaining: string[];
  delegatedTaskCount: number;
  delegateBatchCount: number;
}

export interface WikiBoardProjectionReview {
  verdict: "pass" | "changes_requested";
  reviewedPaths: readonly string[];
}

export interface WikiBoardProjectionTask {
  id: string;
  role: "research" | "write" | "review";
  phase: "queued" | "running" | "paused" | "terminal";
  writePaths?: readonly string[];
  reviewPaths?: readonly string[];
  receipt?: {
    status: "complete" | "incomplete" | "failed";
    error?: { code?: string };
  };
}

export interface WikiBoardProjectionInput {
  runId: string;
  specRevision: number;
  candidateRevision: number;
  compactionObserved: boolean;
  spec?: WikiSpec;
  reviews?: readonly WikiBoardProjectionReview[];
  delegates?: {
    batches: readonly {
      tasks: readonly WikiBoardProjectionTask[];
    }[];
  };
}

export function wikiLeadMayWrite(spec: WikiSpec | undefined, compactionObserved: boolean): boolean {
  if (!spec || compactionObserved) return false;
  return spec.domains.length === 1 && wikiSpecPages(spec).length <= 3;
}

/** Project Lead state onto the host-owned board. Research tasks have no paths and do not change cluster status. */
export function projectWikiBoard(input: WikiBoardProjectionInput): WikiBoardModel {
  const tasks = (input.delegates?.batches ?? []).flatMap((batch) => batch.tasks);
  const reviews = input.reviews ?? [];
  const spec = input.spec;
  const clusters = spec ? wikiSpecClusters(spec).map((id) => projectCluster(id, spec, tasks, reviews)) : [];
  const remaining: string[] = [];
  for (const cluster of clusters) remaining.push(...remainingFor(cluster, tasks, reviews));
  return {
    runId: input.runId,
    specRevision: input.specRevision,
    candidateRevision: input.candidateRevision,
    compactionObserved: input.compactionObserved,
    directWriteAllowed: wikiLeadMayWrite(input.spec, input.compactionObserved),
    clusters,
    tasks: tasks.map(toBoardTask),
    remaining,
    delegatedTaskCount: tasks.length,
    delegateBatchCount: input.delegates?.batches.length ?? 0,
  };
}

function projectCluster(
  id: string,
  spec: WikiSpec,
  tasks: readonly WikiBoardProjectionTask[],
  reviews: readonly WikiBoardProjectionReview[],
): WikiBoardCluster {
  const paths = wikiSpecClusterPaths(spec, id);
  const touching = tasks.filter((task) => task.role !== "research" && taskTouchesCluster(task, id));
  const terminalWriteOrReviewCount = touching.filter((task) => task.phase === "terminal").length;
  const accepted = clusterAccepted(paths, reviews);
  return { id, paths: [...paths], status: clusterStatus(touching, terminalWriteOrReviewCount, accepted), terminalWriteOrReviewCount };
}

function clusterStatus(
  touching: readonly WikiBoardProjectionTask[],
  terminalWriteOrReviewCount: number,
  accepted: boolean,
): WikiBoardClusterStatus {
  if (terminalWriteOrReviewCount >= 3 && !accepted) return "blocked";
  if (accepted) return "accepted";
  if (touching.some((task) => task.role === "review" && task.phase !== "terminal")) return "reviewing";
  if (touching.some((task) => task.role === "write" && (task.phase !== "terminal" || !accepted))) return "writing";
  return "unplanned";
}

function remainingFor(
  cluster: WikiBoardCluster,
  tasks: readonly WikiBoardProjectionTask[],
  reviews: readonly WikiBoardProjectionReview[],
): string[] {
  if (cluster.status === "accepted") return [];
  const lines: string[] = [];
  if (!completeWriteCovers(cluster, tasks)) lines.push(`write ${cluster.id}`);
  lines.push(`review ${cluster.id}`);
  if (reviews.some((review) => review.verdict === "changes_requested" && reviewTouchesCluster(review, cluster.id))) {
    lines.push(`changes_requested ${cluster.id}`);
  }
  if (cluster.status === "blocked") lines.push(`blocked ${cluster.id}`);
  return lines;
}

function clusterAccepted(paths: readonly string[], reviews: readonly WikiBoardProjectionReview[]): boolean {
  const covered = new Set(
    reviews.filter((review) => review.verdict === "pass").flatMap((review) => review.reviewedPaths.map(wikiSpecRelativePath)),
  );
  return paths.length > 0 && paths.every((page) => covered.has(page));
}

function completeWriteCovers(cluster: WikiBoardCluster, tasks: readonly WikiBoardProjectionTask[]): boolean {
  const written = new Set<string>();
  for (const task of tasks) {
    if (task.role !== "write" || task.phase !== "terminal" || task.receipt?.status !== "complete") continue;
    for (const page of task.writePaths ?? []) {
      if (wikiSpecClusterId(page) === cluster.id) written.add(wikiSpecRelativePath(page));
    }
  }
  return cluster.paths.length > 0 && cluster.paths.every((page) => written.has(page));
}

function taskPaths(task: WikiBoardProjectionTask): readonly string[] {
  if (task.role === "write") return task.writePaths ?? [];
  if (task.role === "review") return task.reviewPaths ?? [];
  return [];
}

function taskTouchesCluster(task: WikiBoardProjectionTask, clusterId: string): boolean {
  return taskPaths(task).some((page) => wikiSpecClusterId(page) === clusterId);
}

function reviewTouchesCluster(review: WikiBoardProjectionReview, clusterId: string): boolean {
  return review.reviewedPaths.some((page) => wikiSpecClusterId(page) === clusterId);
}

function toBoardTask(task: WikiBoardProjectionTask): WikiBoardTask {
  return {
    id: task.id,
    role: task.role,
    paths: [...taskPaths(task)],
    phase: task.phase,
    ...(task.receipt ? { receiptStatus: task.receipt.status } : {}),
    ...(task.receipt?.error?.code ? { errorCode: task.receipt.error.code } : {}),
  };
}

/** Host-owned Markdown projection of Lead state so remaining work survives compaction. */
export function renderWikiBoard(model: WikiBoardModel): string {
  const clusters = [...model.clusters]
    .map((cluster) => ({ ...cluster, paths: [...cluster.paths].sort(compareText) }))
    .sort((left, right) => compareText(left.id, right.id));
  const tasks = [...model.tasks].sort((left, right) => compareText(left.id, right.id));

  const lines = [
    "# Wiki board",
    "",
    `- run: ${model.runId}`,
    `- specRevision: ${model.specRevision}`,
    `- candidateRevision: ${model.candidateRevision}`,
    `- compactionObserved: ${yesNo(model.compactionObserved)}`,
    `- directWriteAllowed: ${yesNo(model.directWriteAllowed)}`,
    `- delegatedTasks: ${model.delegatedTaskCount}`,
    `- delegateBatches: ${model.delegateBatchCount}`,
    "",
    "## Clusters",
    "",
  ];

  for (const cluster of clusters) {
    lines.push(`- \`${cluster.id}\` **${cluster.status}** (writes/reviews: ${cluster.terminalWriteOrReviewCount})`);
    for (const page of cluster.paths) lines.push(`  - ${page}`);
  }
  if (clusters.length) lines.push("");

  lines.push("## Tasks", "");
  for (const task of tasks) lines.push(formatTask(task));
  if (tasks.length) lines.push("");

  lines.push("## Remaining", "");
  if (model.remaining.length) {
    for (const line of model.remaining) lines.push(`- ${line}`);
  } else {
    lines.push("- none");
  }

  return `${lines.join("\n")}\n`;
}

function formatTask(task: WikiBoardTask): string {
  const parts = [`\`${task.id}\``, task.role, task.phase];
  if (task.receiptStatus) parts.push(task.receiptStatus);
  if (task.errorCode) parts.push(task.errorCode);
  return `- ${parts.join(" ")}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}
