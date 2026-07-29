/**
 * Tool icon mapping for ToolExecutionCard (transcript / attempt transcript).
 * Single chrome path — NodeAttemptDialog renders tools only via TranscriptMessageList.
 */

import { FileIcon, LayersIcon, SearchIcon, WrenchIcon } from "lucide-react";

export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce";

export function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower === WIKI_PRODUCE_TOOL_NAME) {
    return LayersIcon;
  }
  if (lower === "read" || lower === "write" || lower === "edit" || lower === "ls") {
    return FileIcon;
  }
  if (lower === "grep" || lower === "find") {
    return SearchIcon;
  }
  return WrenchIcon;
}
