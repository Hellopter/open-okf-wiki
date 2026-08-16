import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

/** Project assistant text from a Pi session file. Missing or unreadable files yield no messages. */
export async function readWikiSessionTranscript(sessionFile: string): Promise<ReadonlyArray<{ at: string; text: string }>> {
  try {
    return projectWikiSessionTranscript(await readFile(sessionFile, "utf8"));
  } catch {
    return [];
  }
}

function projectWikiSessionTranscript(content: string): ReadonlyArray<{ at: string; text: string }> {
  const messages: Array<{ at: string; text: string }> = [];
  for (const entry of parseSessionEntries(content)) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    const text = assistantText(entry.message.content);
    if (!text) continue;
    messages.push({ at: entry.timestamp, text });
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
