import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WikiProducer } from "./producer-types.js";

/** Package version; a mismatch pauses the old producer and starts a new one. */
export const WIKI_PRODUCER_HANDOFF_VERSION = "1.0.0";

const SLOT = Symbol.for("okf-wiki.producer-slot");
const TTL_MS = 30_000;
const HEADER_SCAN_BYTES = 64 * 1024;

export interface WikiProducerHost {
  context?: unknown;
}

export interface WikiProducerHandoff {
  producer: WikiProducer;
  workspaceRoot: string;
  version: string;
  host?: WikiProducerHost;
}

interface Slot {
  payload: WikiProducerHandoff;
  timer: ReturnType<typeof setTimeout>;
  onExpire?: (payload: WikiProducerHandoff) => void;
}

type Root = typeof globalThis & { [SLOT]?: Slot | null };

function getSlot(): Slot | null {
  return (globalThis as Root)[SLOT] ?? null;
}

function setSlot(slot: Slot | null): void {
  (globalThis as Root)[SLOT] = slot;
}

/** Take the process-wide producer slot. Identity is the producer object, not a cwd map. */
export function claimProducerSlot(): { compatible?: WikiProducerHandoff; versionMismatch?: WikiProducerHandoff } {
  const slot = getSlot();
  if (!slot) return {};
  clearTimeout(slot.timer);
  setSlot(null);
  return slot.payload.version === WIKI_PRODUCER_HANDOFF_VERSION
    ? { compatible: slot.payload }
    : { versionMismatch: slot.payload };
}

export function handoffProducerSlot(
  payload: WikiProducerHandoff,
  onExpire?: (payload: WikiProducerHandoff) => void,
): void {
  const previous = getSlot();
  if (previous) {
    clearTimeout(previous.timer);
    if (previous.payload.producer !== payload.producer) previous.onExpire?.(previous.payload);
  }
  const next: Slot = {
    payload,
    onExpire,
    timer: setTimeout(() => {
      if (getSlot() !== next) return;
      setSlot(null);
      onExpire?.(payload);
    }, TTL_MS),
  };
  next.timer.unref?.();
  setSlot(next);
}

/** First-line session header probe. Does not call SessionManager.open(). */
export function sessionFileCwd(sessionFile: string | undefined): string | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(4096);
    let scanned = 0;
    let text = "";
    while (scanned < HEADER_SCAN_BYTES) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, HEADER_SCAN_BYTES - scanned), null);
      if (n === 0) {
        text += decoder.end();
        break;
      }
      scanned += n;
      text += decoder.write(buffer.subarray(0, n));
      const nl = text.indexOf("\n");
      if (nl !== -1) {
        text = text.slice(0, nl);
        break;
      }
    }
    const line = text.trim();
    if (!line) return undefined;
    const entry = JSON.parse(line) as { type?: string; cwd?: unknown };
    if (entry.type !== "session" || typeof entry.cwd !== "string" || !entry.cwd) return undefined;
    return resolve(entry.cwd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore probe fd */ }
    }
  }
}
