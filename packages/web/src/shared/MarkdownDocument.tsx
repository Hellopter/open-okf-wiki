/**
 * Shared Streamdown markdown surface for agent transcript + wiki reader.
 * One plugin config; surface prop only adjusts density/controls.
 *
 * Wiki / agent: allow Skill-form `repo:` citation links through rehype-sanitize
 * (default streamdown schema strips them → rehype-harden shows "Source [blocked]").
 */

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import { memo } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

const math = createMathPlugin({
  singleDollarTextMath: true,
  errorColor: "var(--color-muted-foreground)",
});

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

/** Sanitize schema extended so `repo:` Source Citations keep their href. */
function rehypePluginsAllowingRepo() {
  const baseSchema = defaultRehypePlugins.sanitize[1] as {
    protocols?: { href?: string[]; [k: string]: unknown };
    [k: string]: unknown;
  };
  const hrefProtocols = [...(baseSchema.protocols?.href ?? []), "repo"];
  const schema = {
    ...baseSchema,
    protocols: {
      ...baseSchema.protocols,
      href: hrefProtocols,
    },
  };
  return [
    defaultRehypePlugins.raw,
    [defaultRehypePlugins.sanitize[0], schema],
    defaultRehypePlugins.harden,
  ] as NonNullable<React.ComponentProps<typeof Streamdown>["rehypePlugins"]>;
}

const REHYPE_ALLOW_REPO = rehypePluginsAllowingRepo();

export type MarkdownDocumentProps = {
  content: string;
  mode?: "streaming" | "static";
  /** agent = chat density; wiki = full document */
  surface?: "agent" | "wiki";
  className?: string;
  components?: React.ComponentProps<typeof Streamdown>["components"];
};

export const MarkdownDocument = memo(function MarkdownDocument({
  content,
  mode = "static",
  surface = "agent",
  className,
  components,
}: MarkdownDocumentProps) {
  if (!content) return null;

  const streaming = mode === "streaming";

  // CSS for Streamdown code lines targets `.wiki-markdown` / `.agent-markdown`.
  return (
    <div
      data-testid={surface === "wiki" ? "wiki-markdown" : "agent-markdown"}
      data-surface={surface}
      className={cn(
        "okf-md min-w-0 break-words",
        surface === "wiki" ? "wiki-markdown" : "agent-markdown",
        className,
      )}
    >
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        components={components}
        rehypePlugins={REHYPE_ALLOW_REPO}
        // Avoid link-safety modal turning citations into opaque buttons.
        linkSafety={{ enabled: false }}
        lineNumbers={surface === "wiki"}
        controls={{
          code: { copy: true, download: surface === "wiki" },
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
