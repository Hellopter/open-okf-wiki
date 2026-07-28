/**
 * Thin resolveProduceRuntime: picks live vs fixture AgentRunner.
 *
 * Implementation lives in scoped-runner (live) and fixture-runner (fixture).
 * Re-exports keep existing call sites stable.
 */

import type { RetryLimits } from "@okf-wiki/contract";
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
import { createLiveProduceRuntime, type LiveProduceRuntimeDefaults } from "./scoped-runner.js";

export type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  FixtureAgentHook,
  FixtureProduceRuntimeOptions,
  FixtureWriteHook,
  LiveProduceRuntimeDefaults,
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
  /**
   * Live-runtime defaults from workspace limits:
   * - timeoutMs ← requestTimeoutSeconds
   * - retry ← limits.retry (Pi settings.retry)
   */
  defaults?: { timeoutMs?: number; retry?: RetryLimits };
}): AgentRunner {
  if (input.runtime) return input.runtime;
  if (shouldUsePiFixtureMode({ fixture: input.fixture })) {
    return createFixtureProduceRuntime();
  }
  return createLiveProduceRuntime(input.defaults);
}
