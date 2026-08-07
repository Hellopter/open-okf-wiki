/**
 * Minimal structured_output tool for wiki subagents (no DW dependency).
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
}

/**
 * Terminating tool that captures validated params as the subagent result.
 * Pi validates `params` against `schema` before execute().
 */
export function createStructuredOutputTool(options: {
  // JSON Schema / TypeBox schema accepted by Pi tool definitions
  schema: unknown;
  capture: StructuredOutputCapture;
  name?: string;
}): ToolDefinition<any, any> {
  const name = options.name ?? "structured_output";
  const { schema, capture } = options;
  return defineTool({
    name,
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
      `Do not write a prose final answer after calling ${name}.`,
    ],
    parameters: schema as any,
    async execute(_toolCallId, params) {
      capture.value = params;
      capture.called = true;
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  });
}
