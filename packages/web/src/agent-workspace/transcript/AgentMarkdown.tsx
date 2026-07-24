/**
 * Markdown body for agent transcript cards.
 * Streamdown + @streamdown/code (Shiki) + math (KaTeX) + mermaid.
 * Code chrome is styled via data-streamdown selectors in index.css.
 *
 * Setup notes (streamdown v2 + plugins):
 * - Import `katex/dist/katex.min.css` once at app entry (main.tsx).
 * - Tailwind @source must scan streamdown + each plugin package (index.css).
 * - lineNumbers=false: Streamdown omits `block` on line spans — CSS forces it.
 */

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

/** Prefer $$…$$; also accept $…$ (agents often emit single-dollar math). */
const math = createMathPlugin({
  singleDollarTextMath: true,
  errorColor: "var(--color-muted-foreground)",
});

/**
 * Natural diagram size + scroll (useMaxWidth:false) so chat bubbles don't
 * crush SVGs into unreadable micro-diagrams. Fullscreen still available via controls.
 */
const mermaid = createMermaidPlugin({
  config: {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "neutral",
    fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
    fontSize: 16,
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
  },
});

const streamdownPlugins = { cjk, code, math, mermaid };

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
  if (!content) return null;

  return (
    <div
      data-testid="agent-markdown"
      className={cn("session-markdown agent-markdown min-w-0 break-words", className)}
    >
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        /* Chat density: no line numbers; copy only (download is noisy in timeline). */
        lineNumbers={false}
        controls={{
          code: { copy: true, download: false },
          table: true,
          mermaid: { fullscreen: true, download: true, copy: true, panZoom: true },
        }}
        className="size-full space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      >
        {content}
      </Streamdown>
    </div>
  );
});
