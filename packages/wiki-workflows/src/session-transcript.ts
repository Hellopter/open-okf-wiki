import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { open } from "node:fs/promises";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 200;

/** Project assistant text from a Pi session file. Missing or unreadable files yield no messages. */
export async function readWikiSessionTranscript(sessionFile: string): Promise<ReadonlyArray<{ at: string; text: string }>> {
  let handle;
  try {
    handle = await open(sessionFile, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return projectWikiSessionTranscript(tailAfterCompleteLine(buffer.subarray(0, bytesRead), start > 0));
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function tailAfterCompleteLine(content: Buffer, truncated: boolean): string {
  if (!truncated) return content.toString("utf8");
  const newline = content.indexOf(0x0a);
  return newline < 0 ? "" : content.subarray(newline + 1).toString("utf8");
}

function projectWikiSessionTranscript(content: string): ReadonlyArray<{ at: string; text: string }> {
  const messages: Array<{ at: string; text: string }> = [];
  for (const entry of parseSessionEntries(content)) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    const text = assistantText(entry.message.content);
    if (!text) continue;
    messages.push({ at: entry.timestamp, text });
    if (messages.length > MAX_TRANSCRIPT_MESSAGES) messages.shift();
  }
  return messages;
}

function assistantText(content: ReadonlyArray<{ type: string; text?: string }>): string | undefined {
  const text = content
    .flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n")
    .trim();
  return text || undefined;
}
