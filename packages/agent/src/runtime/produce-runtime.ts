/**
 * Thin resolveProduceRuntime: picks live vs fixture AgentRunner.
 *
 * Implementation lives in scoped-runner (live) and fixture-runner (fixture).
 * Re-exports keep existing call sites stable.
 */

import type { AgentRunner } from "../ports/agent-runner.js";
import { shouldUsePiFixtureMode } from "./fixture-mode.js";
import {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
  type FixtureAgentHook,
  type FixtureProduceRuntimeOptions,
  type FixtureWriteHook,
  type ProduceAgentRequest,
  type ProduceAgentResult,
  type ProduceRuntime,
  type ProduceWriteRequest,
  type ProduceWriteResult,
} from "./fixture-runner.js";
import { createLiveProduceRuntime } from "./scoped-runner.js";

export type {
  FixtureAgentHook,
  FixtureProduceRuntimeOptions,
  FixtureWriteHook,
  ProduceAgentRequest,
  ProduceAgentResult,
  ProduceRuntime,
  ProduceWriteRequest,
  ProduceWriteResult,
};
export {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
  createLiveProduceRuntime,
};

export function resolveProduceRuntime(input: {
  fixture?: boolean;
  runtime?: ProduceRuntime;
}): ProduceRuntime {
  if (input.runtime) return input.runtime;
  if (shouldUsePiFixtureMode({ fixture: input.fixture })) {
    return createFixtureProduceRuntime();
  }
  return createLiveProduceRuntime();
}

/** Type guard helper for AgentRunner-as-ProduceRuntime. */
export type { AgentRunner };
