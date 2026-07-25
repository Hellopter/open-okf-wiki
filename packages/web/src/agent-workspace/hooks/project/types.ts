/** View types projected directly from one Pi Operator Session. */

import type { AgentSseEvent, WikiProduceToolDetails } from "@okf-wiki/contract";

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export type AgentToolCall = {
  id: string;
  name: string;
  /** Structured tool arguments from Pi toolCall / tool_execution_start (not stringified). */
  args?: unknown;
  output?: string;
  /** Structured details emitted by the real Pi wiki_produce tool. */
  details?: WikiProduceToolDetails;
  status: "pending" | "running" | "done" | "error";
};

/** Ordered Pi assistant content; tool status lives on AgentMessage.tools. */
export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool"; toolId: string };

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string;
  thinking?: string;
  thinkingStatus?: "streaming" | "done";
  createdAt: string;
  tools?: AgentToolCall[];
  parts?: AgentContentPart[];
  status?: "streaming" | "done" | "error" | "aborted";
  errorText?: string;
  /**
   * Client-only optimistic user row (Composer send).
   * Snapshot projection is authority: optimistic rows do not survive a server
   * snapshot. Live Pi `user` message events are ignored (prefer snapshot).
   */
  optimistic?: true;
};

/** Shared transport interface. Pi still owns event payload internals. */
export type AgentSseLike = AgentSseEvent;

/** Finalized durable rows plus at most one live Pi assistant snapshot. */
export type PiStreamState = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  lastAssistantId: string | null;
  turnActive: boolean;
};
