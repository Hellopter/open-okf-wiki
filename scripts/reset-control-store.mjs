#!/usr/bin/env node

import {
  parseResetWikiRunsControlStoreArgs,
  resetWikiRunsControlStore,
} from "../packages/core/dist/index.js";

const usage = "Usage: pnpm reset-control-store -- --workspace <absolute-path> --yes\n";

try {
  const { rootPath } = parseResetWikiRunsControlStoreArgs(process.argv.slice(2));
  const result = await resetWikiRunsControlStore(rootPath);
  process.stdout.write(
    `Reset WikiRuns control store for ${result.rootPath}: ${result.removed.join(", ")}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n${usage}`);
  process.exitCode = 1;
}
