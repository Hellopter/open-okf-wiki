/**
 * Durable orchestration store: atomic snapshot.json + append-only events.jsonl.
 *
 * Layout: `{workspaceRoot}/.wiki-agent/runs/{runId}/orchestration/`
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentStatus,
  WikiAgentRole,
  WikiAgentView,
  WikiBackend,
  WikiEvent,
  WikiEventType,
  WikiObservationEntry,
  WikiOverallStatus,
  WikiObservationKind,
  WikiPhaseStatus,
  WikiPhaseView,
  WikiProgressSnapshot,
} from "./types.js";

export interface WikiRunStoreOptions {
  workspaceRoot: string;
  runId: string;
  orchRunId?: string;
}

export interface CreateRunOptions {
  orchRunId: string;
  backend: WikiBackend;
  mode: string;
  focus?: string;
  workspaceRoot: string;
  runId: string;
}

/** Alias used by orchestrator backends / package index. */
export type CreateRunInput = CreateRunOptions;

export type WikiRunStoreListener = (snap: WikiProgressSnapshot, event?: WikiEvent) => void;

/** Alias used by orchestrator backends / package index. */
export type SnapshotListener = WikiRunStoreListener;

const SNAPSHOT_FILE = "snapshot.json";
const EVENTS_FILE = "events.jsonl";

/** Path-safe agent id: non-alphanumeric characters become `_`. */
export function safeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9]/g, "_");
}

function nowMs(): number {
  return Date.now();
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

function readJsonl(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  if (!text.trim()) return [];
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

function orchestrationDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, ".wiki-agent", "runs", runId, "orchestration");
}

export class WikiRunStore {
  private workspaceRoot: string;
  private runId: string;
  private orchRunId: string;
  private rootDir: string;
  private snapshot: WikiProgressSnapshot | null = null;
  private seq = 0;
  private readonly listeners = new Set<WikiRunStoreListener>();

  constructor(options: WikiRunStoreOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.runId = options.runId;
    this.orchRunId = options.orchRunId ?? "";
    this.rootDir = orchestrationDir(this.workspaceRoot, this.runId);
    this.loadFromDisk();
  }

  /** Absolute directory holding snapshot.json / events.jsonl / agents/. */
  get storeDir(): string {
    return this.rootDir;
  }

  createRun(options: CreateRunOptions): WikiProgressSnapshot {
    this.workspaceRoot = options.workspaceRoot;
    this.runId = options.runId;
    this.orchRunId = options.orchRunId;
    this.rootDir = orchestrationDir(this.workspaceRoot, this.runId);
    mkdirSync(this.rootDir, { recursive: true });

    const snap: WikiProgressSnapshot = {
      version: 1,
      runId: options.runId,
      orchRunId: options.orchRunId,
      workspaceRoot: options.workspaceRoot,
      mode: options.mode,
      focus: options.focus,
      backend: options.backend,
      overall: "idle",
      phases: [],
      agents: [],
      updatedAt: nowMs(),
    };

    this.snapshot = snap;
    this.seq = 0;
    this.persistSnapshot();
    // Fresh event log for a new run
    writeFileSync(this.eventsPath(), "", "utf8");
    this.notify(snap);
    return this.cloneSnapshot(snap);
  }

  getSnapshot(): WikiProgressSnapshot {
    if (!this.snapshot) {
      this.loadFromDisk();
    }
    if (!this.snapshot) {
      throw new Error("WikiRunStore has no snapshot; call createRun() first");
    }
    return this.cloneSnapshot(this.snapshot);
  }

  updateSnapshot(mutator: (s: WikiProgressSnapshot) => void): WikiProgressSnapshot {
    if (!this.snapshot) {
      this.loadFromDisk();
    }
    if (!this.snapshot) {
      throw new Error("WikiRunStore has no snapshot; call createRun() first");
    }
    mutator(this.snapshot);
    this.snapshot.updatedAt = nowMs();
    this.persistSnapshot();
    this.notify(this.snapshot);
    return this.cloneSnapshot(this.snapshot);
  }

  appendEvent(
    type: WikiEventType,
    fields: {
      agentId?: string;
      phase?: string;
      detail?: unknown;
      runId?: string;
    } = {},
  ): WikiEvent {
    if (!this.snapshot && !this.orchRunId) {
      throw new Error("WikiRunStore.appendEvent requires createRun() first");
    }
    const orchRunId = this.snapshot?.orchRunId ?? this.orchRunId;
    this.seq += 1;
    const event: WikiEvent = {
      ts: Date.now(),
      seq: this.seq,
      type,
      orchRunId,
      runId: fields.runId ?? this.runId,
      agentId: fields.agentId,
      phase: fields.phase,
      detail: fields.detail,
    };

    mkdirSync(this.rootDir, { recursive: true });
    appendFileSync(this.eventsPath(), `${JSON.stringify(event)}\n`, "utf8");

    if (this.snapshot) {
      this.snapshot.updatedAt = nowMs();
      this.persistSnapshot();
      this.notify(this.snapshot, event);
    }

    return event;
  }

  upsertAgent(partial: Partial<WikiAgentView> & { agentId: string }): void {
    this.updateSnapshot((s) => {
      const idx = s.agents.findIndex((a) => a.agentId === partial.agentId);
      if (idx >= 0) {
        s.agents[idx] = { ...s.agents[idx], ...partial };
        return;
      }
      const created: WikiAgentView = {
        agentId: partial.agentId,
        label: partial.label ?? partial.agentId,
        role: (partial.role ?? "main") as WikiAgentRole,
        phase: partial.phase ?? s.currentPhase ?? "",
        prompt: partial.prompt,
        status: (partial.status ?? "queued") as AgentStatus,
        elapsedMs: partial.elapsedMs ?? 0,
        unitIds: partial.unitIds,
        pagePaths: partial.pagePaths,
        model: partial.model,
        startedAt: partial.startedAt,
        endedAt: partial.endedAt,
        lastTool: partial.lastTool,
        lastHeartbeatAt: partial.lastHeartbeatAt,
        lastError: partial.lastError,
        tokenUsage: partial.tokenUsage,
        latestUsage: partial.latestUsage,
        context: partial.context,
        activity: partial.activity,
        compactionCount: partial.compactionCount,
        transcriptPath: partial.transcriptPath,
        sessionKey: partial.sessionKey,
      };
      s.agents.push(created);
    });
  }

  setPhase(name: string, status: WikiPhaseStatus, summary?: string): void {
    this.updateSnapshot((s) => {
      let phase: WikiPhaseView | undefined = s.phases.find((p) => p.name === name);
      if (!phase) {
        phase = { name, status };
        s.phases.push(phase);
      } else {
        phase.status = status;
      }
      if (summary !== undefined) phase.summary = summary;
      if (status === "active") {
        phase.startedAt = phase.startedAt ?? nowMs();
        s.currentPhase = name;
      }
      if (status === "done" || status === "failed" || status === "skipped") {
        phase.endedAt = nowMs();
      }
    });
  }

  setOverall(overall: WikiOverallStatus): void {
    this.updateSnapshot((s) => {
      s.overall = overall;
    });
  }

  appendTranscript(agentId: string, entry: WikiObservationEntry): void {
    const safeId = safeAgentId(agentId);
    const agentDir = join(this.rootDir, "agents", safeId);
    mkdirSync(agentDir, { recursive: true });
    const file = join(agentDir, "transcript.jsonl");
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");

    if (this.snapshot) {
      this.updateSnapshot((s) => {
        const agent = s.agents.find((a) => a.agentId === agentId);
        if (agent) agent.transcriptPath = file;
      });
    }
  }

  readTranscript(agentId: string, options: { tail?: number } = {}): WikiObservationEntry[] {
    const file = join(this.rootDir, "agents", safeAgentId(agentId), "transcript.jsonl");
    const rows = readJsonl(file).filter(
      isWikiObservationEntry,
    );
    if (options.tail != null && options.tail >= 0) {
      return rows.slice(-options.tail);
    }
    return rows;
  }

  listEvents(options: { tail?: number } = {}): WikiEvent[] {
    const rows = readJsonl(this.eventsPath()).filter(isWikiEvent);
    if (options.tail != null && options.tail >= 0) {
      return rows.slice(-options.tail);
    }
    return rows;
  }

  subscribe(listener: WikiRunStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private eventsPath(): string {
    return join(this.rootDir, EVENTS_FILE);
  }

  private snapshotPath(): string {
    return join(this.rootDir, SNAPSHOT_FILE);
  }

  private persistSnapshot(): void {
    if (!this.snapshot) return;
    writeJsonAtomic(this.snapshotPath(), this.snapshot);
  }

  private loadFromDisk(): void {
    const snapPath = this.snapshotPath();
    if (!existsSync(snapPath)) return;
    try {
      const raw = JSON.parse(readFileSync(snapPath, "utf8")) as WikiProgressSnapshot;
      this.snapshot = raw;
      this.orchRunId = raw.orchRunId || this.orchRunId;
      this.runId = raw.runId;
      if (raw.workspaceRoot) this.workspaceRoot = raw.workspaceRoot;
    } catch {
      this.snapshot = null;
    }

    const events = this.listEvents();
    if (events.length > 0) {
      this.seq = events[events.length - 1]!.seq;
    }
  }

  private notify(snap: WikiProgressSnapshot, event?: WikiEvent): void {
    const clone = this.cloneSnapshot(snap);
    for (const listener of this.listeners) {
      try {
        listener(clone, event);
      } catch {
        // listeners must not break the store
      }
    }
  }

  private cloneSnapshot(snap: WikiProgressSnapshot): WikiProgressSnapshot {
    return structuredClone(snap);
  }

}

function isWikiEvent(value: unknown): value is WikiEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.seq === "number" && typeof v.type === "string" && typeof v.orchRunId === "string";
}

function isWikiObservationEntry(value: unknown): value is WikiObservationEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const validRoles = new Set(["assistant", "tool", "system"]);
  const validKinds: ReadonlySet<WikiObservationKind> = new Set([
    "text", "tool_start", "tool_end", "retry_start", "retry_end",
    "compaction_start", "compaction_end", "summarization_retry",
  ]);
  return typeof row.timestamp === "number"
    && typeof row.role === "string"
    && validRoles.has(row.role)
    && typeof row.kind === "string"
    && validKinds.has(row.kind as WikiObservationKind);
}
