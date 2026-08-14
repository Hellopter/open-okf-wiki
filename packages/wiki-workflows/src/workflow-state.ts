import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeText } from "./files.js";

export interface WikiReviewFinding {
  path: string;
  severity: "critical" | "major" | "minor";
  message: string;
  evidence: string[];
  suggestion: string;
}

export interface WikiReviewResult {
  verdict: "pass" | "changes_requested";
  reviewedPaths: string[];
  findings: WikiReviewFinding[];
  profileCoverage: string[];
}

export interface WikiRevisionSnapshot { specRevision: number; writeRevision: number }

interface ReviewRecord extends WikiReviewResult, WikiRevisionSnapshot { taskId: string }
interface WorkflowStateData { version: 1; compactionObserved: boolean; writeRevision: number; reviews: ReviewRecord[] }
type Persist = (location: string, content: string) => Promise<void>;

const EMPTY: WorkflowStateData = { version: 1, compactionObserved: false, writeRevision: 0, reviews: [] };

export class WikiWorkflowState {
  private data: WorkflowStateData = structuredClone(EMPTY);
  private queue = Promise.resolve();

  private constructor(private readonly location: string, private readonly write: Persist) {}

  static async open(workspace: string, runId: string, options: { persist?: Persist } = {}): Promise<WikiWorkflowState> {
    const location = path.join(workspace, ".okf-wiki", "runs", runId, "workflow-state.json");
    const state = new WikiWorkflowState(location, options.persist ?? persistState);
    try {
      state.data = parseState(JSON.parse(await readFile(location, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return state;
  }

  get compactionObserved(): boolean { return this.data.compactionObserved; }
  get writeRevision(): number { return this.data.writeRevision; }
  snapshot(specRevision: number): WikiRevisionSnapshot { return { specRevision, writeRevision: this.data.writeRevision }; }

  async observeCompaction(): Promise<void> {
    if (this.data.compactionObserved) return;
    await this.mutate((next) => { next.compactionObserved = true; });
  }

  /** Persist review invalidation before the candidate file is replaced. */
  async beginWrite(): Promise<number> {
    await this.mutate((next) => { next.writeRevision += 1; next.reviews = []; });
    return this.data.writeRevision;
  }

  async invalidateReviews(): Promise<void> { await this.mutate((next) => { next.reviews = []; }); }

  async acceptReview(taskId: string, captured: WikiRevisionSnapshot, currentSpecRevision: number, result: WikiReviewResult): Promise<boolean> {
    let accepted = false;
    await this.mutate((next) => {
      if (captured.specRevision !== currentSpecRevision || captured.writeRevision !== next.writeRevision) return;
      next.reviews = next.reviews.filter((review) => review.taskId !== taskId);
      next.reviews.push({ ...structuredClone(result), taskId, ...captured });
      accepted = true;
    });
    return accepted;
  }

  assertPublishable(specRevision: number, requiredPaths: readonly string[], requiredProfileCoverage: readonly string[]): void {
    const current = this.data.reviews.filter((review) => review.specRevision === specRevision && review.writeRevision === this.data.writeRevision);
    const requested = current.find((review) => review.verdict === "changes_requested");
    if (requested) throw new Error(`Wiki review requested changes in task ${requested.taskId}`);
    const covered = new Set(current.filter((review) => review.verdict === "pass").flatMap((review) => review.reviewedPaths));
    const missing = requiredPaths.filter((page) => !covered.has(page));
    if (missing.length) throw new Error(`Current Wiki revision lacks passing independent review for: ${missing.join(", ")}`);
    const profile = new Set(current.filter((review) => review.verdict === "pass").flatMap((review) => review.profileCoverage));
    const missingProfile = requiredProfileCoverage.filter((item) => !profile.has(item));
    if (missingProfile.length) throw new Error(`Current Wiki review does not cover profile requirements: ${missingProfile.join(", ")}`);
  }

  private async mutate(change: (next: WorkflowStateData) => void): Promise<void> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.data);
      change(next);
      await this.write(this.location, `${JSON.stringify(next, null, 2)}\n`);
      this.data = next;
    });
    this.queue = operation.catch(() => {});
    await operation;
  }
}

async function persistState(location: string, content: string): Promise<void> {
  await mkdir(path.dirname(location), { recursive: true });
  await writeText(location, content);
}

function parseState(value: unknown): WorkflowStateData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki workflow state");
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some((key) => !["version", "compactionObserved", "writeRevision", "reviews"].includes(key))
    || state.version !== 1 || typeof state.compactionObserved !== "boolean"
    || !Number.isSafeInteger(state.writeRevision) || (state.writeRevision as number) < 0 || !Array.isArray(state.reviews)) {
    throw new Error("Invalid Wiki workflow state");
  }
  return {
    version: 1,
    compactionObserved: state.compactionObserved,
    writeRevision: state.writeRevision as number,
    reviews: state.reviews.map(parseReview),
  };
}

function parseReview(value: unknown): ReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki workflow review state");
  const review = value as Record<string, unknown>;
  const keys = ["taskId", "specRevision", "writeRevision", "verdict", "reviewedPaths", "findings", "profileCoverage"];
  if (Object.keys(review).some((key) => !keys.includes(key)) || typeof review.taskId !== "string" || !review.taskId
    || !Number.isSafeInteger(review.specRevision) || (review.specRevision as number) < 1
    || !Number.isSafeInteger(review.writeRevision) || (review.writeRevision as number) < 0
    || !["pass", "changes_requested"].includes(String(review.verdict))
    || !strings(review.reviewedPaths) || !strings(review.profileCoverage) || !Array.isArray(review.findings)) {
    throw new Error("Invalid Wiki workflow review state");
  }
  return { ...(review as unknown as ReviewRecord), findings: review.findings.map(parseFinding) };
}

function parseFinding(value: unknown): WikiReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki review finding state");
  const finding = value as Record<string, unknown>;
  const keys = ["path", "severity", "message", "evidence", "suggestion"];
  if (Object.keys(finding).some((key) => !keys.includes(key)) || typeof finding.path !== "string" || !finding.path
    || !["critical", "major", "minor"].includes(String(finding.severity)) || typeof finding.message !== "string" || !finding.message
    || !strings(finding.evidence) || typeof finding.suggestion !== "string" || !finding.suggestion) throw new Error("Invalid Wiki review finding state");
  return finding as unknown as WikiReviewFinding;
}

function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0); }
