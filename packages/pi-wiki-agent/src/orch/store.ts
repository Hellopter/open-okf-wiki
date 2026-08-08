/** Durable observation store: ordered snapshot, event, and transcript writes. */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  AgentStatus,
  WikiAgentRole,
  WikiAgentView,
  WikiEvent,
  WikiEventType,
  WikiObservationEntry,
  WikiObservationKind,
  WikiOverallStatus,
  WikiPhaseStatus,
  WikiPhaseView,
  WikiProgressSnapshot,
} from "./types.js";

export interface WikiRunStoreOptions {
  workspaceRoot: string;
  runId: string;
  orchestrationId?: string;
  now?: () => number;
}

export interface CreateRunOptions {
  orchestrationId: string;
  backend: "session";
  mode: string;
  focus?: string;
  workspaceRoot: string;
  runId: string;
}

export type CreateRunInput = CreateRunOptions;
export type WikiRunStoreListener = (snap: WikiProgressSnapshot, event?: WikiEvent) => void;
export type SnapshotListener = WikiRunStoreListener;

const SNAPSHOT_FILE = "snapshot.json";
const EVENTS_FILE = "events.jsonl";

export function safeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9]/g, "_");
}

function orchestrationDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, ".wiki-agent", "runs", runId, "orchestration");
}

function parseJsonl(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially-written line must not prevent recovery of prior observations.
    }
  }
  return rows;
}

async function readJsonl(file: string): Promise<unknown[]> {
  try {
    return parseJsonl(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/**
 * Mutations update the in-memory projection synchronously, then share one write
 * chain. This preserves event sequence and disk ordering even when callers do
 * not await individual observation updates from agent callbacks.
 */
export class WikiRunStore {
  private workspaceRoot: string;
  private runId: string;
  private orchestrationId: string;
  private rootDir: string;
  private snapshot: WikiProgressSnapshot | null = null;
  private seq = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private persistenceFailure: unknown;
  private readonly listeners = new Set<WikiRunStoreListener>();
  private readonly now: () => number;

  constructor(options: WikiRunStoreOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.runId = options.runId;
    this.orchestrationId = options.orchestrationId ?? "";
    this.rootDir = orchestrationDir(this.workspaceRoot, this.runId);
    this.now = options.now ?? Date.now;
  }

  get storeDir(): string {
    return this.rootDir;
  }

  /** Explicit recovery is async; normal new runs call createRun instead. */
  async load(): Promise<boolean> {
    await this.flush();
    try {
      const raw = JSON.parse(await readFile(this.snapshotPath(), "utf8")) as WikiProgressSnapshot;
      if (!isWikiProgressSnapshot(raw)) return false;
      this.snapshot = raw;
      this.workspaceRoot = raw.workspaceRoot;
      this.runId = raw.runId;
      this.orchestrationId = raw.orchestrationId;
      this.rootDir = orchestrationDir(this.workspaceRoot, this.runId);
      const events = (await readJsonl(this.eventsPath())).filter(isWikiEvent);
      this.seq = events.at(-1)?.seq ?? 0;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  createRun(options: CreateRunOptions): WikiProgressSnapshot {
    this.workspaceRoot = options.workspaceRoot;
    this.runId = options.runId;
    this.orchestrationId = options.orchestrationId;
    this.rootDir = orchestrationDir(this.workspaceRoot, this.runId);
    const snapshot: WikiProgressSnapshot = {
      version: 1,
      runId: options.runId,
      orchestrationId: options.orchestrationId,
      workspaceRoot: options.workspaceRoot,
      mode: options.mode,
      focus: options.focus,
      backend: options.backend,
      overall: "idle",
      phases: [],
      agents: [],
      updatedAt: this.now(),
    };
    this.snapshot = snapshot;
    this.seq = 0;
    void this.enqueue(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await writeFile(this.eventsPath(), "", "utf8");
      await writeJsonAtomic(this.snapshotPath(), snapshot);
    });
    this.notify(snapshot);
    return this.clone(snapshot);
  }

  getSnapshot(): WikiProgressSnapshot {
    if (!this.snapshot) throw new Error("WikiRunStore has no snapshot; call createRun() or load() first");
    return this.clone(this.snapshot);
  }

  updateSnapshot(mutator: (snapshot: WikiProgressSnapshot) => void): WikiProgressSnapshot {
    const snapshot = this.requireSnapshot();
    mutator(snapshot);
    snapshot.updatedAt = this.now();
    this.persistSnapshot();
    this.notify(snapshot);
    return this.clone(snapshot);
  }

  appendEvent(
    type: WikiEventType,
    fields: { agentId?: string; phase?: string; detail?: unknown; runId?: string } = {},
  ): WikiEvent {
    const snapshot = this.requireSnapshot();
    const event: WikiEvent = {
      ts: this.now(),
      seq: ++this.seq,
      type,
      orchestrationId: snapshot.orchestrationId,
      runId: fields.runId ?? this.runId,
      agentId: fields.agentId,
      phase: fields.phase,
      detail: fields.detail,
    };
    void this.enqueue(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await appendFile(this.eventsPath(), `${JSON.stringify(event)}\n`, "utf8");
    });
    snapshot.updatedAt = this.now();
    this.persistSnapshot();
    this.notify(snapshot, event);
    return event;
  }

  upsertAgent(partial: Partial<WikiAgentView> & { agentId: string }): void {
    this.updateSnapshot((snapshot) => {
      const index = snapshot.agents.findIndex((agent) => agent.agentId === partial.agentId);
      if (index >= 0) {
        snapshot.agents[index] = { ...snapshot.agents[index], ...partial };
        return;
      }
      snapshot.agents.push({
        ...partial,
        agentId: partial.agentId,
        label: partial.label ?? partial.agentId,
        role: (partial.role ?? "main") as WikiAgentRole,
        phase: partial.phase ?? snapshot.currentPhase ?? "",
        status: (partial.status ?? "queued") as AgentStatus,
        elapsedMs: partial.elapsedMs ?? 0,
      });
    });
  }

  setPhase(name: string, status: WikiPhaseStatus, summary?: string): void {
    this.updateSnapshot((snapshot) => {
      let phase = snapshot.phases.find((entry) => entry.name === name);
      if (!phase) {
        phase = { name, status };
        snapshot.phases.push(phase);
      } else {
        phase.status = status;
      }
      if (summary !== undefined) phase.summary = summary;
      if (status === "active") {
        phase.startedAt ??= this.now();
        snapshot.currentPhase = name;
      }
      if (status === "done" || status === "failed" || status === "skipped") phase.endedAt = this.now();
    });
  }

  setOverall(overall: WikiOverallStatus): void {
    this.updateSnapshot((snapshot) => { snapshot.overall = overall; });
  }

  appendTranscript(agentId: string, entry: WikiObservationEntry): void {
    const file = join(this.rootDir, "agents", safeAgentId(agentId), "transcript.jsonl");
    void this.enqueue(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    });
    if (this.snapshot) {
      this.updateSnapshot((snapshot) => {
        const agent = snapshot.agents.find((candidate) => candidate.agentId === agentId);
        if (agent) agent.transcriptPath = file;
      });
    }
  }

  async readTranscript(agentId: string, options: { tail?: number } = {}): Promise<WikiObservationEntry[]> {
    await this.flush();
    const file = join(this.rootDir, "agents", safeAgentId(agentId), "transcript.jsonl");
    const entries = (await readJsonl(file)).filter(isWikiObservationEntry);
    return options.tail != null && options.tail >= 0 ? entries.slice(-options.tail) : entries;
  }

  async listEvents(options: { tail?: number } = {}): Promise<WikiEvent[]> {
    await this.flush();
    const events = (await readJsonl(this.eventsPath())).filter(isWikiEvent);
    return options.tail != null && options.tail >= 0 ? events.slice(-options.tail) : events;
  }

  /** Wait until every mutation queued before this call is durable. */
  flush(): Promise<void> {
    return this.writeChain.then(() => {
      if (this.persistenceFailure) throw this.persistenceFailure;
    });
  }

  subscribe(listener: WikiRunStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireSnapshot(): WikiProgressSnapshot {
    if (!this.snapshot) throw new Error("WikiRunStore has no snapshot; call createRun() or load() first");
    return this.snapshot;
  }

  private eventsPath(): string { return join(this.rootDir, EVENTS_FILE); }
  private snapshotPath(): string { return join(this.rootDir, SNAPSHOT_FILE); }

  private persistSnapshot(): void {
    const snapshot = this.requireSnapshot();
    void this.enqueue(() => writeJsonAtomic(this.snapshotPath(), this.clone(snapshot)));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const write = this.writeChain.then(async () => {
      if (this.persistenceFailure) return;
      try {
        await operation();
      } catch (error) {
        this.persistenceFailure ??= error;
      }
    });
    this.writeChain = write;
    return write;
  }

  private notify(snapshot: WikiProgressSnapshot, event?: WikiEvent): void {
    const clone = this.clone(snapshot);
    for (const listener of this.listeners) {
      try { listener(clone, event); } catch { /* observers cannot affect persistence */ }
    }
  }

  private clone(snapshot: WikiProgressSnapshot): WikiProgressSnapshot {
    return structuredClone(snapshot);
  }
}

function isWikiProgressSnapshot(value: unknown): value is WikiProgressSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.runId === "string" && typeof snapshot.orchestrationId === "string";
}

function isWikiEvent(value: unknown): value is WikiEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.seq === "number" && typeof event.type === "string" && typeof event.orchestrationId === "string";
}

function isWikiObservationEntry(value: unknown): value is WikiObservationEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const kinds: ReadonlySet<WikiObservationKind> = new Set([
    "text", "tool_start", "tool_end", "retry_start", "retry_end",
    "compaction_start", "compaction_end", "summarization_retry",
  ]);
  return typeof entry.timestamp === "number"
    && (entry.role === "assistant" || entry.role === "tool" || entry.role === "system")
    && typeof entry.kind === "string"
    && kinds.has(entry.kind as WikiObservationKind);
}
