import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyEnvFile, parseEnvFile } from "./load-env.ts";

test("parseEnvFile handles comments, export, and quotes", () => {
  const parsed = parseEnvFile(`
# comment
export OKF_LOG_LEVEL=debug
OKF_LOG_FILE="/tmp/a.jsonl"
EMPTY=
OKF_WIKI_PORT=8788
not a line
`);
  assert.equal(parsed.OKF_LOG_LEVEL, "debug");
  assert.equal(parsed.OKF_LOG_FILE, "/tmp/a.jsonl");
  assert.equal(parsed.OKF_WIKI_PORT, "8788");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed["not a line"], undefined);
});

test("applyEnvFile does not override existing process env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "okf-env-"));
  const file = path.join(dir, ".env");
  await writeFile(file, "OKF_TEST_KEY=from-file\nOKF_TEST_KEEP=file\n", "utf8");
  const env: NodeJS.ProcessEnv = { OKF_TEST_KEEP: "already" };
  assert.equal(applyEnvFile(file, env), true);
  assert.equal(env.OKF_TEST_KEY, "from-file");
  assert.equal(env.OKF_TEST_KEEP, "already");
});
