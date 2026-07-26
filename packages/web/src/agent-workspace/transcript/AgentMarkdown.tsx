/**
 * Markdown body for agent transcript cards.
 * Thin wrapper over shared MarkdownDocument (surface=agent).
 * `MarkdownDocument` applies `.agent-markdown` for index.css streamdown chrome.
 */

import { memo } from "react";
import { MarkdownDocument } from "../../shared/MarkdownDocument";

export type AgentMarkdownProps = {
  content: string;
  /** When true, use streaming mode so incomplete fences still paint. */
  streaming?: boolean;
  className?: string;
};

export const AgentMarkdown = memo(function AgentMarkdown({
  content,
  streaming = false,
  className,
}: AgentMarkdownProps) {
  return (
    <MarkdownDocument
      content={content}
      mode={streaming ? "streaming" : "static"}
      surface="agent"
      className={className}
    />
  );
});
