/**
 * Grep result filtering for Effective Source Ignores (ADR 0030).
 *
 * CONTRACT: filter BOTH final result content AND onUpdate partials the same
 * way so ignored paths never leak on the stream.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertPathAllowed, isIgnoredSourceRel, type SourceIgnoreInput } from "./path-policy.js";

export type GrepIgnoreFilterContext = {
  runWorkDir: string;
  /** Absolute directory used to resolve relative paths in grep output lines. */
  resultBase: string;
  sourceIgnores: SourceIgnoreInput;
};

/** Extract the file path prefix from a ripgrep-style `path:line:text` or `path-line-text` line. */
export function grepResultPath(line: string): string | undefined {
  return /^(.*?)(?::\d+:|-\d+-)/.exec(line)?.[1];
}

/**
 * Pure filter for a single grep content text blob.
 * Drops lines whose path matches source ignores; lines without a path are kept.
 * When every match line is dropped, returns "No matches found".
 */
export function filterGrepContentText(text: string, ctx: GrepIgnoreFilterContext): string {
  let keptMatch = false;
  const lines = text.split("\n").filter((line) => {
    const resultPath = grepResultPath(line);
    if (!resultPath) {
      return true;
    }
    const absoluteResult = path.resolve(ctx.resultBase, resultPath);
    const rel = path.relative(path.resolve(ctx.runWorkDir), absoluteResult).replace(/\\/g, "/");
    if (isIgnoredSourceRel(rel, ctx.sourceIgnores)) {
      return false;
    }
    keptMatch = true;
    return true;
  });
  return keptMatch ? lines.join("\n") : "No matches found";
}

type GrepContentPart = { type: string; text?: string };
type GrepToolResult = { content?: GrepContentPart[]; [key: string]: unknown };

function filterGrepResultContent(
  result: GrepToolResult,
  ctx: GrepIgnoreFilterContext,
): GrepToolResult {
  if (!Array.isArray(result.content)) {
    return result;
  }
  return {
    ...result,
    content: result.content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") {
        return part;
      }
      return {
        ...part,
        text: filterGrepContentText(part.text, ctx),
      };
    }),
  };
}

export type GrepSourceIgnoreFilterOptions = {
  runWorkDir: string;
  sourceIgnores?: SourceIgnoreInput;
};

/**
 * Wrap a relative-path-guarded grep tool so Source Ignores apply to both the
 * final result and every onUpdate partial.
 */
export function withGrepSourceIgnoreFilter<T extends ToolDefinition<any, any>>(
  definition: T,
  options: GrepSourceIgnoreFilterOptions,
): T {
  if (!options.sourceIgnores) {
    return definition;
  }
  const sourceIgnores = options.sourceIgnores;
  const execute = definition.execute;
  return {
    ...definition,
    execute: (async (
      toolCallId: string,
      input: { path?: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: unknown,
    ) => {
      const searchPath = assertPathAllowed(options.runWorkDir, input.path || ".", {
        mode: "read",
        sourceIgnores,
      });
      const searchInfo = await stat(searchPath);
      const resultBase = searchInfo.isDirectory() ? searchPath : path.dirname(searchPath);
      const ctx: GrepIgnoreFilterContext = {
        runWorkDir: options.runWorkDir,
        resultBase,
        sourceIgnores,
      };

      const wrappedOnUpdate =
        typeof onUpdate === "function"
          ? (partial: GrepToolResult) => {
              (onUpdate as (p: GrepToolResult) => void)(filterGrepResultContent(partial, ctx));
            }
          : onUpdate;

      const result = (await (execute as unknown as (...args: any[]) => Promise<GrepToolResult>)(
        toolCallId,
        input,
        signal,
        wrappedOnUpdate,
        context,
      )) as GrepToolResult;

      return filterGrepResultContent(result, ctx);
    }) as unknown as T["execute"],
  };
}
