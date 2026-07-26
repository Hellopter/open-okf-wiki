/**
 * Red/green diff preview for `edit` tool calls (Claude Code style):
 * old_string lines with a "-" gutter on destructive tint, new_string lines
 * with a "+" gutter on success tint. Not an LCS diff — the two blocks are
 * exactly what the model sent, which is what the operator wants to verify.
 */

import { cn } from "@/lib/utils";

function DiffLines({ text, sign }: { text: string; sign: "-" | "+" }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div
      className={cn(
        "flex flex-col",
        sign === "-" ? "bg-destructive/8 text-destructive" : "bg-success/8 text-success",
      )}
    >
      {lines.map((line, i) => (
        <div key={i} className="flex min-w-0">
          <span className="w-5 shrink-0 select-none text-center opacity-60">{sign}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] pr-2">
            {line || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DiffPreview({ removed, added }: { removed?: string; added?: string }) {
  if (!removed && !added) return null;
  return (
    <div
      className="max-h-64 min-w-0 max-w-full overflow-auto rounded-md border border-border/70 font-mono text-xs leading-relaxed"
      data-testid="tool-diff-preview"
    >
      {removed ? <DiffLines text={removed} sign="-" /> : null}
      {added ? <DiffLines text={added} sign="+" /> : null}
    </div>
  );
}
