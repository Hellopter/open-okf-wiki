#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set(["dist", "node_modules", "playwright-report", "test-results"]);
const failures = [];

function filesUnder(relativeDir) {
  const start = path.join(root, relativeDir);
  if (!existsSync(start)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) {
        files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      }
    }
  };
  visit(start);
  return files;
}

const packageFiles = filesUnder("packages");
const sourceFiles = packageFiles.filter((file) => file.includes("/src/"));
const productSourceFiles = sourceFiles.filter(
  (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.includes("/fixtures/"),
);

for (const file of [...filesUnder("packages/cli"), ...filesUnder("apps/desktop")]) {
  failures.push(`${file}: CLI/Desktop operator package must stay deleted`);
}

const removedModulePaths = [
  /\/WorkspaceRunPage\./,
  /\/agent\/src\/(?:wiki-run|shell\/wiki-run-shell)\./,
  /\/session-run-transition\./,
  /\/server\/src\/session\/product-inject\./,
  /\/agent\/src\/pi\//,
  /\/agent\/src\/produce\/produce-wiki\./,
  /\/agent\/src\/produce\/wiki-produce-tool\./,
  /\/agent\/src\/produce\/submit-wiki-run-spec-tool\./,
  /\/agent\/src\/produce\/tools\/(?:parent-wiki-produce-tool|wiki-produce-progress)\./,
  /\/agent\/src\/workflow\/(?:run-wiki|gate-protocol|run-phase-writer|repair-guarded|run-graph-owner|journal|produce)\./,
  /\/agent\/src\/ports\/(?:graph-store|core-graph-store)\./,
  /\/agent\/src\/ports\/(?:progress-sink|receipt-store|core-receipt-store)\./,
  /\/agent\/src\/produce\/(?:defects|defects-io|review|publishability)\./,
  /\/agent\/src\/runtime\/produce-runtime\./,
  /\/core\/src\/(?:run-store|run-graph)\./,
  /\/agent\/src\/tools\/wiki-produce-details\./,
  /\/contract\/src\/(?:events|gate-ui|interaction|session)\./,
  /\/web\/src\/agent-workspace\/(?:components\/(?:ProduceTrail|ProduceUnitCard)|hooks\/project\/produce|panels\/AgentTree)\./,
];

for (const file of sourceFiles) {
  if (removedModulePaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: removed compatibility/operator module must stay deleted`);
  }
}

const forbiddenSourceRules = [
  ["removed WikiRunShell compatibility surface", /\b(?:WorkspaceRunPage|WikiRunShell)\b/],
  [
    "product-injected event channel",
    /\b(?:PRODUCT_INJECT_KINDS|ProductSseEvent|ProductAgentEvent|ProductInjectTarget|assertProductInject|emitProductAgentEvent|injectProductEvent|getRecentAgentSessionEvents)\b|source\s*:\s*["']product["']/,
  ],
  [
    "event ring/replay protocol",
    /\b(?:MAX_RECENT|nextSequence|lastEventId|replayCursor|replayEvents?|ringBuffer)\b|\bsequence\s*[?:]\s*(?:number|z\.)/,
  ],
  [
    "Session side metadata/path discovery",
    /\b(?:sessionMetaPath|readSessionMeta|writeSessionMeta(?:RunId)?|sessionWorkDir|findPiSessionFile|resolveSessionHistoryFile|isPiSessionJsonlName|agentSessionExistsOnDisk)\b/,
  ],
  [
    "duplicate Produce projection",
    /\b(?:OKF_PRODUCE_PROGRESS\w*|ProduceUnit|produceUnits|buildProduceTree|produceDisplayRoots|produceUnitsFromSessionEntries|childPiEvent|applyChildStreamEvent|workStreamsFromAgents|workStreams|WorkStreams|workAgents|upsertOperatorWorkAgent|OperatorWorkAgent|ProduceChildPiEvent|readOperatorWorkSnapshot|WorkUnit|parentVisibility|applyPiEvent|ProjectedHistoryMessage|attachWorkUnitSink|ProductWorkUnit)\b|okf\.produce_progress|child_pi|agent_span|operator-work|work_unit|work-unit-coalesce|operator-trajectory/,
  ],
  ["legacy WikiRunPlan contract", /\bWikiRunPlan\b/],
  [
    "hand-rolled legacy agent protocol",
    /\b(?:toAISdkStream|SessionMessageSchema|SessionMessagePart|appendSessionMessages)\b|["'](?:list_source|read_source|write_wiki)["']/,
  ],
  [
    "removed Run Graph predecessor (children spans)",
    /\b(?:WikiProduceChildSpan|WikiProduceChildItem|WikiProduceChildSpanSchema|WikiProduceChildItemSchema)\b/,
  ],
  [
    "memory HITL / long runWiki produce ownership (T2/T7 hard-cut)",
    /\b(?:resume_gate|pendingGates|runWiki\s*\(|WikiRunShell|gate-protocol|GatePort|createRunPhaseController|repairWikiGuarded|createToolDetailsAccumulator|createRunGraphOwner|AttemptJournal|freezeWikiRun\s*\()/,
  ],
  [
    "WikiRunPhase as scheduler truth (T7 — WikiRuns owns control)",
    /\b(?:WikiRunPhaseSchema|assertPhaseTransition|isPhaseTransitionAllowed|recordStatusFromPhase|toolStatusFromPhase|phaseAllowsCancel|phaseGate)\b/,
  ],
  [
    "legacy dual-path Run surfaces (hard-cut)",
    /\b(?:registerRunRecord|handleGetRunGraph|produceWiki\s*\(|repairWiki\s*\(|createCoreGraphStore|loadRunGraph|writeRunGraph|updateRunRecord)\b/,
  ],
  [
    "agent ProgressSink museum residue (B1 — projection is Run SSE / workflow)",
    /\b(?:ProgressSink|progressSinkFromCallback)\b/,
  ],
  [
    "agent ReceiptStore museum residue (B1 — WikiRuns owns receipts)",
    /\b(?:ReceiptStore|createCoreReceiptStore|defaultReceiptStore)\b/,
  ],
  [
    "agent produce review/defects/publishability museum residue (B1 — workflow mechanical/review-reduce only)",
    /\b(?:runReviewCouncil|scorePublishable|mergeDefectReports|parseDefectReportFromText)\b/,
  ],
  [
    "core one-shot publish + legacy run record path (B3 — split primitives / WikiRuns only)",
    /\b(?:publishStagingToPublication|runRecordPath)\b/,
  ],
];

const allowedProductDependencies = {
  "@okf-wiki/contract": new Set(),
  "@okf-wiki/core": new Set(["@okf-wiki/contract", "@okf-wiki/skill"]),
  "@okf-wiki/workflow": new Set(["@okf-wiki/contract", "@okf-wiki/core"]),
  "@okf-wiki/agent": new Set(["@okf-wiki/contract", "@okf-wiki/core"]),
  "@okf-wiki/server": new Set([
    "@okf-wiki/agent",
    "@okf-wiki/contract",
    "@okf-wiki/core",
    "@okf-wiki/workflow",
  ]),
  "@okf-wiki/web": new Set(["@okf-wiki/contract"]),
  "@okf-wiki/skill": new Set(),
};

for (const file of productSourceFiles) {
  const content = readFileSync(path.join(root, file), "utf8");
  for (const [label, pattern] of forbiddenSourceRules) {
    const match = pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    failures.push(`${file}:${line}: ${label}: ${JSON.stringify(match[0])}`);
  }
}

/**
 * Test-only hooks may live next to module-private state, but production
 * call sites must not import them. Definitions are allowlisted; imports of
 * *ForTests / @okf-wiki/agent/testing are forbidden outside tests.
 */
const forTestsDefinitionAllowlist = [
  /\/agent-session-registry\.ts$/,
  /\/agent-session\/test-seams\.ts$/,
  /\/agent-session-events\.ts$/,
  /\/operator-session-test-seams\.ts$/,
  /\/agent\/src\/testing\.ts$/,
];

const forTestsImportExempt = [/\/agent\/src\/testing\.ts$/, /\/operator-session-test-seams\.ts$/];

for (const file of productSourceFiles) {
  if (forTestsImportExempt.some((pattern) => pattern.test(file))) continue;
  const content = readFileSync(path.join(root, file), "utf8");
  const importMatch =
    /\bfrom\s*["']@okf-wiki\/agent\/testing["']|\bfrom\s*["'][^"']*operator-session-test-seams[^"']*["']|\bimport\s*\{[^}]*\b\w+ForTests\b/.exec(
      content,
    );
  if (importMatch) {
    const line = content.slice(0, importMatch.index).split("\n").length;
    failures.push(
      `${file}:${line}: production code must not import test-only hooks (*ForTests / agent/testing)`,
    );
  }
  if (
    /\b(?:export\s+)?(?:async\s+)?function\s+\w+ForTests\b|\bas\s+\w+ForTests\b/.test(content) &&
    !forTestsDefinitionAllowlist.some((pattern) => pattern.test(file))
  ) {
    const match = /\b\w+ForTests\b/.exec(content);
    const line = match ? content.slice(0, match.index).split("\n").length : 1;
    failures.push(
      `${file}:${line}: *ForTests definitions only allowed on allowlisted modules (or use @okf-wiki/agent/testing)`,
    );
  }
}

for (const file of filesUnder("packages/core/src").filter(
  (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
)) {
  const content = readFileSync(path.join(root, file), "utf8");
  const match = /\btestProviderConnection\b|\bfetch\s*\(/.exec(content);
  if (!match) continue;
  const line = content.slice(0, match.index).split("\n").length;
  failures.push(`${file}:${line}: provider transport belongs to Agent, not Core`);
}

/**
 * HTTP routes must not leak raw unknown errors. Use sendCaughtError (or
 * trySendCoreDomainError then sendCaughtError). Static-string sendError and
 * typed domain error.message (after instanceof + status map) remain allowed.
 */
const routeErrorLeakRules = [
  [
    "raw unknown error ternary (use sendCaughtError)",
    /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\s*\(\s*error\s*\)/,
  ],
  [
    "raw String(error) in sendError (use sendCaughtError)",
    /sendError\s*\([^;]*\bString\s*\(\s*error\s*\)/,
  ],
  [
    "raw error.message with literal status (use sendCaughtError or typed status map)",
    /sendError\s*\(\s*\w+\s*,\s*\d+\s*,\s*error\.message\b/,
  ],
];
for (const file of productSourceFiles.filter((file) =>
  file.startsWith("packages/server/src/routes/"),
)) {
  const content = readFileSync(path.join(root, file), "utf8");
  for (const [label, pattern] of routeErrorLeakRules) {
    const match = pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    failures.push(`${file}:${line}: ${label}: ${JSON.stringify(match[0])}`);
  }
}

/**
 * agent/ports must stay free of Pi SDK and agent pi/produce/runtime modules
 * (ADR 0033 §3). Adapters under runtime cast opaque port types to Pi types.
 * Matches static `from`, bare side-effect imports, and dynamic `import(...)`,
 * including barrel imports of the directory itself.
 */
const portForbidden =
  /(?:from\s*|import\s*\(\s*|import\s+)["'](?:@earendil-works\/[^"']+|[^"']*\/(?:pi|produce|runtime)(?:\/[^"']*)?)["']/;
for (const file of filesUnder("packages/agent/src/ports").filter(
  (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
)) {
  const content = readFileSync(path.join(root, file), "utf8");
  const piImport = portForbidden.exec(content);
  if (piImport) {
    const line = content.slice(0, piImport.index).split("\n").length;
    failures.push(
      `${file}:${line}: ports must not import Pi SDK, pi/, produce/, or runtime/ (DIP): ${JSON.stringify(piImport[0])}`,
    );
  }
}

/**
 * workflow/** must not import tools/ or session/ (orchestration vs tool edge).
 * Pi SDK value imports are also banned under workflow. Matches barrel imports
 * (`from "../tools"`) and dynamic `import(...)` too.
 */
const workflowForbidden =
  /(?:from\s*|import\s*\(\s*|import\s+)["'](?:@earendil-works\/[^"']+|[^"']*\/(?:tools|session)(?:\/[^"']*)?)["']/;
for (const file of filesUnder("packages/agent/src/workflow").filter(
  (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
)) {
  const content = readFileSync(path.join(root, file), "utf8");
  const bad = workflowForbidden.exec(content);
  if (bad) {
    const line = content.slice(0, bad.index).split("\n").length;
    failures.push(
      `${file}:${line}: workflow must not import Pi SDK, tools/, or session/: ${JSON.stringify(bad[0])}`,
    );
  }
}

/**
 * Cross-package dependency edges enforced at the source level too, so an
 * import cannot bypass package.json (e.g. via workspace hoisting).
 */
const packageDirToName = {
  "packages/contract": "@okf-wiki/contract",
  "packages/core": "@okf-wiki/core",
  "packages/workflow": "@okf-wiki/workflow",
  "packages/agent": "@okf-wiki/agent",
  "packages/server": "@okf-wiki/server",
  "packages/web": "@okf-wiki/web",
  "packages/skill": "@okf-wiki/skill",
};
const importSpecifierRe = /(?:from\s*|import\s*\(\s*|import\s+)["'](@okf-wiki\/[a-z-]+)/g;
for (const file of productSourceFiles) {
  const dir = Object.keys(packageDirToName).find((d) => file.startsWith(`${d}/`));
  if (!dir) continue;
  const selfName = packageDirToName[dir];
  const allowed = allowedProductDependencies[selfName];
  const content = readFileSync(path.join(root, file), "utf8");
  for (const match of content.matchAll(importSpecifierRe)) {
    const target = match[1].replace(/\/(?:testing)$/, "");
    if (target === selfName) continue;
    if (!allowed?.has(target)) {
      const line = content.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: forbidden source import edge ${selfName} -> ${target}`);
    }
  }
}

for (const file of packageFiles.filter((file) => file.endsWith("/package.json"))) {
  const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const allowed = allowedProductDependencies[manifest.name];
  for (const dependency of Object.keys(dependencies)) {
    if (
      dependency === "ai" ||
      dependency.startsWith("@ai-sdk/") ||
      dependency.startsWith("@mastra/") ||
      dependency === "@okf-wiki/cli"
    ) {
      failures.push(`${file}: forbidden dependency ${dependency}`);
    }
    if (manifest.name !== "@okf-wiki/agent" && dependency.startsWith("@earendil-works/pi-")) {
      failures.push(`${file}: only @okf-wiki/agent may depend on Pi (${dependency})`);
    }
    if (dependency.startsWith("@okf-wiki/") && !allowed?.has(dependency)) {
      failures.push(`${file}: forbidden product dependency edge ${manifest.name} -> ${dependency}`);
    }
  }
}

for (const file of ["package.json", "tsconfig.json", "pnpm-workspace.yaml"]) {
  const content = readFileSync(path.join(root, file), "utf8");
  if (/packages\/cli|apps\/\*|apps\/desktop|@okf-wiki\/cli/.test(content)) {
    failures.push(`${file}: CLI/Desktop workspace reference must stay deleted`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exit(1);
}

console.log("check-architecture: ok");
