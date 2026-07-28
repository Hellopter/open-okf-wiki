/**
 * Factory for wiki Semantic Workflow Pi sessions (ADR 0030).
 *
 * Always passes a role allowlist from tool-policy (bash only via explicit
 * operator toolSelection opt-in; never for Semantic Workflow roles).
 * Registers Operations-wrapped Pi tools via `customTools` so write scope and
 * Source Ignores are enforced at the FS layer (see fs-operations.ts).
 * Model is optional so offline/fixture tests work without API keys.
 *
 * Product Settings integration:
 * - compaction from maxContextTokens + contextTargetTokens
 * - retry from workspace.limits.retry (Pi settings.retry shape)
 * - skills via additionalSkillPaths (producer / workspace / home)
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RetryLimits } from "@okf-wiki/contract";
import {
  type ContextBudget,
  compactionSettingsFromBudget,
  resolveSeatContextBudget,
} from "./context-budget.js";
import { buildWikiScopedToolDefinitions } from "./fs-operations.js";
import type { SourceIgnoreInput } from "./path-policy.js";
import {
  assertSafeWikiToolList,
  type PiFsToolName,
  resolveOperatorToolNames,
  roleMayWrite,
  toolNamesForRole,
  type WikiAgentRole,
} from "./tool-policy.js";

/** Pi settings.retry input (mirrors contract RetryLimits / Pi RetrySettings). */
export type WikiSessionRetryInput = {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  provider?: {
    maxRetries?: number;
    maxRetryDelayMs?: number;
    timeoutMs?: number;
  };
};

export type CreateWikiSessionInput = {
  role: WikiAgentRole;
  /** Pi cwd = run workdir layout (sources/, skill/, wiki/, analysis/). */
  runWorkDir: string;
  /** Optional model; omit for offline session construction (no prompt). */
  model?: Model<any>;
  /** Optional system prompt override (via DefaultResourceLoader). */
  systemPrompt?: string;
  /** Operator Sessions inject their sole durable SessionManager; child Sessions default in-memory. */
  sessionManager?: SessionManager;
  /** Optional ModelRuntime for live enterprise gateways. */
  modelRuntime?: ModelRuntime;
  /**
   * Pi agentDir for settings/auth discovery.
   * Defaults to `{runWorkDir}/.okf-pi-agent` (isolated per run).
   */
  agentDir?: string;
  /**
   * Effective Source Ignores for Operations path guards
   * (sourceId → repo-relative globs, or a flat pattern list).
   */
  sourceIgnores?: SourceIgnoreInput;
  /**
   * Workdir-relative trees denied for all Operations access modes.
   * Operator Sessions pass `.okf-wiki` so product meta (Pi settings/auth,
   * session JSONL, run scratch) stays unreadable from chat.
   */
  denyPrefixes?: readonly string[];
  /**
   * Operator tool selection (workspace.operatorTools) — operator_chat only.
   * Subset of read/grep/find/ls/bash; bash is an explicit trust opt-in and
   * bypasses Operations scoping. Semantic Workflow roles never accept this.
   */
  toolSelection?: readonly string[];
  /**
   * When true (default), pass Operations-wrapped tools as `customTools`
   * (write → wiki/ + analysis/ only; reads honor sourceIgnores).
   * Set false to use stock Pi built-ins (allowlist only).
   */
  scopedTools?: boolean;
  /**
   * Provider hard context window (tokens). Used with contextTargetTokens
   * to configure Pi auto-compaction. Clamped to model.contextWindow when set.
   */
  maxContextTokens?: number;
  /**
   * Workspace operational context budget. When unset, 85% of maxContextTokens.
   */
  contextTargetTokens?: number;
  /**
   * Pi auto-retry policy (workspace.limits.retry). Defaults match contract
   * RetryLimits: enabled, maxRetries=2, baseDelayMs=2000, provider.maxRetries=0.
   */
  retry?: WikiSessionRetryInput | RetryLimits;
  /**
   * Product skill directories for Pi (producer / workspace / home).
   * Injected as additionalSkillPaths with noSkills:true (skip Pi defaults).
   */
  additionalSkillPaths?: readonly string[];
  /** Additional real Pi custom tools (for example operator wiki_produce). */
  customTools?: ToolDefinition<any, any>[];
};

export type WikiSessionHandle = {
  session: AgentSession;
  role: WikiAgentRole;
  /** Tool allowlist actually passed to createAgentSession. */
  tools: readonly string[];
  runWorkDir: string;
  /** True when Operations-scoped customTools were registered. */
  scopedTools: boolean;
  /** Resolved context budget applied to compaction (if any). */
  contextBudget?: ContextBudget;
  dispose: () => void;
};

/** Resolve and assert the tool allowlist for a role (unit-testable). */
export function resolveWikiSessionTools(role: WikiAgentRole): readonly PiFsToolName[] {
  const tools = toolNamesForRole(role);
  assertSafeWikiToolList(tools);
  return tools;
}

/**
 * Build customTools that override Pi built-ins with write-scope / ignore ops.
 * createAgentSession accepts `customTools?: ToolDefinition[]` and merges them
 * over built-ins by name — this is the supported Operations injection path.
 */
export function buildWikiSessionCustomTools(input: {
  role: WikiAgentRole;
  runWorkDir: string;
  sourceIgnores?: SourceIgnoreInput;
  denyPrefixes?: readonly string[];
}): ToolDefinition<any, any>[] {
  return buildWikiScopedToolDefinitions({
    runWorkDir: input.runWorkDir,
    mayWrite: roleMayWrite(input.role),
    sourceIgnores: input.sourceIgnores,
    denyPrefixes: input.denyPrefixes,
  });
}

/**
 * Create an AgentSession bound to a run workdir with role tool policy.
 * Does not call prompt — safe offline when model is omitted.
 */
export async function createWikiSession(input: CreateWikiSessionInput): Promise<WikiSessionHandle> {
  if (input.toolSelection !== undefined && input.role !== "operator_chat") {
    throw new Error("toolSelection is only valid for operator_chat sessions");
  }
  const selection =
    input.role === "operator_chat" && input.toolSelection !== undefined
      ? resolveOperatorToolNames(input.toolSelection)
      : undefined;
  const tools: readonly string[] = selection ?? resolveWikiSessionTools(input.role);
  if (!selection) assertSafeWikiToolList(tools);

  const runWorkDir = path.resolve(input.runWorkDir);
  await mkdir(runWorkDir, { recursive: true });

  const agentDir = path.resolve(input.agentDir ?? path.join(runWorkDir, ".okf-pi-agent"));
  await mkdir(agentDir, { recursive: true });

  const sessionManager = input.sessionManager ?? SessionManager.inMemory(runWorkDir);

  const maxFromModel =
    typeof input.model?.contextWindow === "number" && input.model.contextWindow > 0
      ? input.model.contextWindow
      : undefined;
  const budget = resolveSeatContextBudget({
    maxContextTokens: input.maxContextTokens,
    modelContextWindow: maxFromModel,
    contextTargetTokens: input.contextTargetTokens,
  });

  // Align model.contextWindow with the product budget on a session-local copy.
  // The resolved Pi Model handle is shared across the plan session, parallel
  // leaf/domain sessions, and the long-lived Operator Session — mutating it
  // would race concurrent sessions with different budgets.
  let sessionModel = input.model;
  if (sessionModel && sessionModel.contextWindow !== budget.contextWindow) {
    const proto = Object.getPrototypeOf(sessionModel) as object | null;
    sessionModel =
      proto === Object.prototype || proto === null
        ? { ...sessionModel, contextWindow: budget.contextWindow }
        : Object.assign(Object.create(proto), sessionModel, {
            contextWindow: budget.contextWindow,
          });
  }

  const retry = {
    enabled: input.retry?.enabled ?? true,
    maxRetries: input.retry?.maxRetries ?? 2,
    baseDelayMs: input.retry?.baseDelayMs ?? 2000,
    provider: {
      maxRetries: input.retry?.provider?.maxRetries ?? 0,
      maxRetryDelayMs: input.retry?.provider?.maxRetryDelayMs ?? 60_000,
      ...(input.retry?.provider?.timeoutMs != null
        ? { timeoutMs: input.retry.provider.timeoutMs }
        : {}),
    },
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: compactionSettingsFromBudget(budget),
    retry,
  });

  const skillPaths = (input.additionalSkillPaths ?? []).map((p) => p.trim()).filter(Boolean);

  const resourceLoader = new DefaultResourceLoader({
    cwd: runWorkDir,
    agentDir,
    settingsManager,
    systemPrompt: input.systemPrompt,
    noExtensions: true,
    // Skip Pi built-in skills; inject product skill paths only.
    noSkills: true,
    additionalSkillPaths: skillPaths.length > 0 ? skillPaths : undefined,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const useScoped = input.scopedTools !== false;
  const scopedAll = useScoped
    ? buildWikiSessionCustomTools({
        role: input.role,
        runWorkDir,
        sourceIgnores: input.sourceIgnores,
        denyPrefixes: input.denyPrefixes,
      })
    : [];
  // With an operator selection, only build scoped defs for selected fs tools;
  // `bash` (if selected) flows through the allowlist to the stock Pi tool.
  const scopedTools = selection
    ? scopedAll.filter((definition) => tools.includes(definition.name))
    : scopedAll;
  const customTools = [...scopedTools, ...(input.customTools ?? [])];
  const toolList = [...new Set([...tools, ...customTools.map((definition) => definition.name)])];

  const { session } = await createAgentSession({
    cwd: runWorkDir,
    agentDir,
    tools: toolList,
    customTools: customTools.length > 0 ? customTools : undefined,
    sessionManager,
    settingsManager,
    resourceLoader,
    model: sessionModel,
    modelRuntime: input.modelRuntime,
  });

  return {
    session,
    role: input.role,
    tools,
    runWorkDir,
    scopedTools: useScoped,
    contextBudget: budget,
    dispose: () => {
      session.dispose();
    },
  };
}
