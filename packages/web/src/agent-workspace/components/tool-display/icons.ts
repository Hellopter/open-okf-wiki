/**
 * Tool icon mapping shared by ToolExecutionCard (transcript) and
 * NodeAttemptDialog (run graph) so the two tool-trail renderings cannot drift.
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
