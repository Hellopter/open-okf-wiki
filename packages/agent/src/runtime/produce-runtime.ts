/**
 * Thin resolveProduceRuntime: picks live vs fixture AgentRunner.
 *
 * Implementation lives in scoped-runner (live) and fixture-runner (fixture).
 * Re-exports keep existing call sites stable.
 */

import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  WikiWriteRequest,
  WikiWriteResult,
} from "../ports/agent-runner.js";
import { shouldUsePiFixtureMode } from "./fixture-mode.js";
import {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
  type FixtureAgentHook,
  type FixtureProduceRuntimeOptions,
  type FixtureWriteHook,
} from "./fixture-runner.js";
import { createLiveProduceRuntime } from "./scoped-runner.js";

export type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  FixtureAgentHook,
  FixtureProduceRuntimeOptions,
  FixtureWriteHook,
  WikiWriteRequest,
  WikiWriteResult,
};
export {
  createFixtureProduceRuntime,
  createLiveProduceRuntime,
  createScriptedReviewFixtureRuntime,
};

export function resolveProduceRuntime(input: {
  fixture?: boolean;
  runtime?: AgentRunner;
  /** Live-runtime defaults (per-session wall-clock budget from workspace limits). */
  defaults?: { timeoutMs?: number };
}): AgentRunner {
  if (input.runtime) return input.runtime;
  if (shouldUsePiFixtureMode({ fixture: input.fixture })) {
    return createFixtureProduceRuntime();
  }
  return createLiveProduceRuntime(input.defaults);
}
