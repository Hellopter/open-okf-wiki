/**
 * Explicit fixture-mode selection for no-LLM smoke paths.
 *
 * Never auto-selected because credentials are missing. Env opt-in is ignored
 * when NODE_ENV=production so production deploys always require real models.
 */

export function shouldUsePiFixtureMode(
  input: { fixture?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.fixture === true) return true;
  if (input.fixture === false) return false;
  if (env.NODE_ENV === "production") return false;
  return env.OKF_WIKI_AGENT_MODE === "fixture";
}
