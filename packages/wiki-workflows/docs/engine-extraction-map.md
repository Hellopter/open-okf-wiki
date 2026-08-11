# WikiWorkflowEngine extraction map

Source of truth: [`src/engine.ts`](../src/engine.ts) (2282 lines as of this map).

**Goal:** split the monolithic `WikiWorkflowEngine` into focused modules without changing behavior. This document is a concrete move plan for later agents.

**Target modules (under `src/` unless noted):**

| Target | Responsibility |
| --- | --- |
| `run-service.ts` | Lifecycle API: start/restore/retry/fork/pause/resume/cancel/interrupt/serialize/subscribe |
| `coordinator.ts` | Pump loop, concurrency batches, node execution, activity streaming, terminal-run marking |
| `transitions.ts` | `afterSuccess` graph expansion, all `queue*`, coverage/repair budgets, submission fit checks |
| `prompts.ts` | Agent prompt assembly and prompt-context helpers |
| `handoffs.ts` | Artifact store lifecycle, persist/prepare handoffs, research receipt loading, fork copy |
| facade (`engine.ts`) | Class shell, shared state, re-export public API, thin wiring |

Suggested shared helpers (optional later split, not required for first cut):

- `engine-utils.ts` — pure utilities (`clone`, `stableStringify`, fingerprints, retained text, etc.)
- `node-input.ts` — input parsers / interfaces (`ResearchNodeInput`, `pagePacketInputFor`, …)

---

## 1. Class methods → target files

Line ranges are inclusive start…end of the method body as currently in `engine.ts`.

### 1.1 Stay in facade (`engine.ts`)

| Method | Lines | Notes |
| --- | ---: | --- |
| `constructor` | 91–105 | Builds `dependencies`; owns injected artifact-store flags |
| `emit` | 1353–1362 | Event bus; used by every module |
| `nodeById` | 1364–1366 | Shared lookup |
| `requireNode` | 1368–1372 | Shared lookup |
| `requireRun` | 1374–1377 | Shared lookup |
| `now` | 1379–1381 | Clock injection |
| `newId` | 1383–1385 | ID injection |

**Facade also keeps:**

- Class fields: `dependencies`, `current`, `listeners`, `controllers`, `lastActivityEventAt`, `hasInjectedArtifactStore`, `artifactStore`, `artifactStoreWorkspace`, `pumping`, `pendingTerminalEvent` (74–89)
- Exported type `WikiWorkflowEngineOptions` (66–68)
- Exported factory `createWikiWorkflowEngine` (1388–1390) — may stay here or re-export from `run-service`
- Public method *signatures* that delegate into extracted modules (thin wrappers)

### 1.2 `run-service.ts` — lifecycle API

| Method | Lines | Visibility | Notes |
| --- | ---: | --- | --- |
| `start` | 107–135 | public | Creates inspect root, schedules pump |
| `getSnapshot` | 137–139 | public | Cloned snapshot |
| `listSnapshots` | 141–144 | public | Single-current-run list |
| `subscribe` | 146–149 | public | Listener set |
| `serialize` | 151–153 | public | Session export |
| `restore` | 155–178 | public | Requeue running nodes, pause |
| `retryNode` | 180–187 | public | |
| `retryPhase` | 190–202 | public | Uses `nodesInPhase` / `phaseRetryRoots` |
| `forkAndRetryNode` | 205–207 | public | |
| `forkAndRetryPhase` | 210–214 | public | |
| `forkAndRetry` | 217–260 | private | Fork graph + `copyArtifactsForFork` + `retryRoots` |
| `retryRoots` | 262–285 | private | Git reconcile or invalidate+schedule |
| `pause` | 287–293 | public | |
| `resume` | 295–310 | public | |
| `cancel` | 312–329 | public | |
| `interrupt` | 332–349 | public | Shutdown path |
| `waitForIdle` | 352–355 | public | Awaits `pumping` |
| `reconcileGitInputs` | 1212–1226 | private | Used by retry/resume |
| `invalidateFrom` | 1228–1230 | private | |
| `invalidateFromMany` | 1232–1244 | private | Abort + invalidate/requeue |
| `abortControllers` | 1307–1310 | private | Also used by coordinator terminal paths |

**Depends on:** `handoffs.copyArtifactsForFork` / `ensureArtifactStore`, `coordinator.schedule`, `transitions.queueNode`/`newNode` (for `start`), facade `emit`/`requireRun`/`now`/`newId`.

### 1.3 `coordinator.ts` — pump, batch, execute

| Method | Lines | Visibility | Notes |
| --- | ---: | --- | --- |
| `schedule` | 357–363 | private | Sets `pumping`; re-enters while runnable |
| `pump` | 365–389 | private | Priority: research → validate/review → write → other |
| `executeBatch` | 391–396 | private | `Promise.allSettled` + fan-in reconcile |
| `reconcileCompletedBatch` | 399–416 | private | **historical; removed** — fan-in is success-path only via `tryJoinAfterSuccess` / `evaluateJoin` (`join-barrier.ts`) after `status=succeeded` |
| `runnableNodes` | 418–422 | private | Queued + deps succeeded |
| `executeNode` | 424–510 | private | Attempt budget, research validation, afterSuccess |
| `executeNodeWork` | 512–564 | private | Inspect/validate/finalize local; else executor |
| `updateActivity` | 1246–1252 | private | |
| `updateOutput` | 1254–1259 | private | |
| `updateHistory` | 1261–1266 | private | |
| `emitActivity` | 1268–1274 | private | Throttled `node_activity` |
| `archiveAttempt` | 1293–1305 | private | |
| `markTerminalRun` | 1312–1330 | private | Sets status + deferred terminal event |
| `emitPendingTerminalEvent` | 1332–1345 | private | Flushed after batches |
| `failRun` | 1347–1351 | private | Pump rejection path |

**Constants that move with coordinator:**

- `MAX_NODE_ATTEMPTS` (53)
- `MAX_CONCURRENT_RESEARCHERS` (54)
- `MAX_CONCURRENT_WRITERS` (55)
- `ACTIVITY_EVENT_INTERVAL_MS` (63)
- `MAX_NODE_OUTPUT_CHARS` / `MAX_NODE_HISTORY_*` if retained helpers stay colocated with execute (59–61)
- `MAX_EVENTS` can stay with facade `emit` (62)

**Depends on:** `prompts.promptFor`, `handoffs.persistNodeHandoff` / `researchReceiptsForNode` / `artifactWritePathForNode`, `transitions.afterSuccess` / `validateControlSubmission`, facade state.

### 1.4 `transitions.ts` — afterSuccess and queue*

| Method | Lines | Visibility | Notes |
| --- | ---: | --- | --- |
| `afterSuccess` | 654–773 | private | Switch on node kind; core expansion |
| `queueInitialSourceSurveys` | 775–784 | private | Inspect → research |
| `queueSupplementalResearch` | 786–802 | private | Synthesis expand |
| `queueCoverageAudit` | 804–826 | private | Dry coverage audits |
| `queueResearch` | 828–849 | private | Shared research enqueue |
| `queueSynthesis` | 851–867 | private | Research fan-in → plan |
| `queueStructuralResearch` | 869–881 | private | Structural re-plan via audit research |
| `queuePageWriters` | 883–935 | private | Finalize synthesis → write wave |
| `queueVerification` | 937–951 | private | Write fan-in → validate+review |
| `maybeCompleteVerification` | 953–1012 | private | Validate/review fan-in routing |
| `queuePageRepairs` | 1014–1089 | private | Local repair write wave |
| `ensureResearchRoundAvailable` | 1091–1096 | private | Round budget guard |
| `validateControlSubmission` | 1099–1105 | private | Executor submit-time hook |
| `ensureSynthesisSubmissionFitsRun` | 1107–1115 | private | |
| `ensureReviewSubmissionFitsRun` | 1117–1120 | private | |
| `ensureNewResearchScopes` | 1122–1129 | private | |
| `ensureResearchSourcePaths` | 1131–1138 | private | |
| `ensureSynthesisSpecReceipts` | 1140–1171 | private | Finding coverage / critical gaps |
| `queueNode` | 1173–1184 | private | Push + emit queued |
| `newNode` | 1186–1210 | private | Node factory |
| `previousReviewSignature` | 1276–1282 | private | No-progress block |
| `previousValidationSignature` | 1284–1291 | private | No-progress block |

**Constants that move with transitions:**

- `MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN` (56)
- `MAX_STRUCTURAL_RESYNTHESES` (57)
- `DEFAULT_MAX_RESEARCH_ROUNDS` (58) — also used by `start` via `validMaxResearchRounds`
- `REQUIRED_DRY_COVERAGE_AUDITS` (59)
- `MISSING_PAGE_SHA256` (64)

**Interfaces that move with transitions (or shared `node-input.ts`):**

- `ResearchNodeInput` (1714–1724)
- `SynthesisNodeInput` (1735–1746)
- `QueueSynthesisInput` (1748–1757)
- `PagePacketInput` (1759–1772)

### 1.5 `prompts.ts`

No class methods today — only free functions (see §2). Coordinator calls `promptFor` from `executeNodeWork` (539).

### 1.6 `handoffs.ts`

| Method | Lines | Visibility | Notes |
| --- | ---: | --- | --- |
| `persistNodeHandoff` | 566–590 | private | finalize/write artifact |
| `artifactWritePathForNode` | 592–597 | private | prepare path for agents |
| `researchReceiptsForNode` | 599–621 | private | Load artifacts for prompts |
| `ensureArtifactStore` | 623–630 | private | Lazy workspace store |
| `requireArtifactStore` | 632–635 | private | |
| `copyArtifactsForFork` | 637–652 | private | Used by `forkAndRetry` |

**Also:** free function `artifactKindForNode` (1471–1480), `writeReport` (1914–1940), `isMissingArtifactError` (2263–2265).

---

## 2. Free functions at bottom of `engine.ts` → target homes

| Function | Lines | Target | Rationale |
| --- | ---: | --- | --- |
| `createWikiWorkflowEngine` | 1388–1390 | facade (export) | Public factory |
| `nodesInPhase` | 1392–1406 | `run-service.ts` | Phase retry |
| `phaseRetryRoots` | 1408–1412 | `run-service.ts` | Phase retry roots |
| `affectedNodeIds` | 1414–1426 | `run-service.ts` | Invalidate/fork closure |
| `resetForkedNode` | 1428–1441 | `run-service.ts` | Fork reset |
| `phaseTitle` | 1443–1445 | `run-service.ts` | Retry messages |
| `phaseTitleFor` | 1447–1458 | `run-service.ts` / shared | Also used by `newNode` |
| `isTerminalRun` | 1459–1461 | shared / facade | Fork + markTerminal |
| `roleFor` | 1463–1469 | `coordinator.ts` | Executor role |
| `artifactKindForNode` | 1471–1480 | `handoffs.ts` | Handoff kind map |
| `promptFor` | 1482–1510 | `prompts.ts` | Main prompt entry |
| `pageWriterContext` | 1512–1537 | `prompts.ts` | |
| `pageTypesFor` | 1539–1541 | `prompts.ts` | Guidance page types |
| `synthesisContext` | 1543–1590 | `prompts.ts` | |
| `artifactWriteContext` | 1592–1599 | `prompts.ts` | |
| `reviewContext` | 1601–1615 | `prompts.ts` | |
| `writerFeedbackForPrompt` | 1617–1630 | `prompts.ts` | |
| `structuralTriggerForPrompt` | 1632–1645 | `prompts.ts` | |
| `publicReviewDefect` | 1647–1652 | `prompts.ts` | |
| `publicValidationIssue` | 1654–1659 | `prompts.ts` | |
| `normalizeNodeResult` | 1662–1678 | `coordinator.ts` | Post-execute normalize |
| `parseInspection` | 1680–1695 | `transitions.ts` / shared | afterSuccess inspect |
| `parseValidation` | 1696–1707 | `transitions.ts` / shared | verify path |
| `isValidationIssue` | 1709–1712 | shared with parseValidation | |
| `researchInputFor` | 1774–1797 | shared (`node-input`) | Heavy cross-use |
| `sameResearchBatch` | 1799–1806 | `transitions.ts` | Research fan-in |
| `synthesisInputFor` | 1808–1828 | shared (`node-input`) | |
| `pagePacketInputFor` | 1830–1855 | shared (`node-input`) | |
| `safePagePacketInput` | 1857–1863 | `transitions.ts` | Repair round counting |
| `writePathsFor` | 1865–1868 | `coordinator.ts` | Executor write allowlist |
| `readRootsFor` | 1871–1883 | `coordinator.ts` + prompts | Executor + prompt context |
| `wikiReadPathsFor` | 1886–1899 | `coordinator.ts` + prompts | |
| `derivedIndexWikiPaths` | 1901–1911 | shared | wiki read paths |
| `writeReport` | 1914–1940 | `handoffs.ts` | Writer handoff body |
| `workspaceWikiPath` | 1942–1946 | shared | Paths |
| `synthesisNodeIdFor` | 1948–1962 | shared | Upstream walk |
| `specForSynthesis` | 1964–1968 | shared | Spec lookup |
| `isSynthesisFinalizeResult` | 1970–1977 | shared | |
| `ensureReviewTargets` | 1978–1983 | `transitions.ts` | Review fit |
| `repairInputForPage` | 1985–1996 | `transitions.ts` | Repair feedback |
| `structuralFeedbackForPage` | 1998–2002 | `transitions.ts` | Structural write feedback |
| `specPages` | 2004–2006 | shared | Spec walk |
| `overviewPage` | 2008–2012 | `transitions.ts` | Writers/repairs |
| `normalizePagePath` | 2014–2016 | shared | |
| `shouldWriteContentPage` | 2018–2024 | `transitions.ts` | Refresh filter |
| `relatedWikiPaths` | 2026–2031 | `transitions.ts` | Writer inputs |
| `relativeWikiHref` | 2033–2035 | `prompts.ts` | Cross-link hrefs |
| `routeReviewDefects` | 2037–2052 | `transitions.ts` | Verify routing |
| `researchIdsForPage` | 2054–2057 | `transitions.ts` | Repair research deps |
| `selectResearchIdsForFindings` | 2059–2073 | `transitions.ts` | Write research deps |
| `hashWikiPage` | 2075–2083 | `transitions.ts` / coordinator | Write verify + repair before hash |
| `isSpecPage` | 2085–2090 | shared with page packet | |
| `isSourceDriftResult` | 2092–2095 | `transitions.ts` | Finalize case |
| `recordStringArray` | 2097–2101 | shared util | |
| `recordValue` | 2103–2105 | shared util | |
| `sameStringSet` | 2107–2110 | shared util | |
| `isResearchReceipt` | 2112–2121 | shared | |
| `isArtifactRef` | 2123–2134 | shared / handoffs | |
| `isStringArray` | 2136–2138 | shared util | |
| `uniqueStrings` | 2140–2142 | shared util | |
| `inspectionFingerprint` | 2144–2151 | `run-service.ts` / transitions | Git reconcile + inspect |
| `retainedOutput` | 2153–2165 | `coordinator.ts` | |
| `retainedHistory` | 2167–2179 | `coordinator.ts` | |
| `retainedText` | 2181–2193 | `coordinator.ts` | |
| `defectsFingerprint` | 2195–2201 | `transitions.ts` | |
| `validationIssuesFingerprint` | 2203–2209 | `transitions.ts` | |
| `isStructuralValidationIssue` | 2211–2213 | `transitions.ts` | |
| `normalizeIssueText` | 2215–2217 | `transitions.ts` | |
| `mergeMetrics` | 2219–2227 | `coordinator.ts` | |
| `valueIs` | 2229–2231 | shared util | |
| `stableStringify` | 2233–2238 | shared util | |
| `prettyJson` | 2240–2247 | `prompts.ts` | |
| `normalizeText` | 2248–2251 | `run-service.ts` | `start` focus |
| `errorMessage` | 2253–2255 | `coordinator.ts` | `failRun` |
| `validMaxResearchRounds` | 2257–2261 | `run-service.ts` | `start` |
| `isMissingArtifactError` | 2263–2265 | `handoffs.ts` | |
| `isMissingFileError` | 2267–2269 | shared | writeReport / hash |
| `pathIsInside` | 2271–2274 | `handoffs.ts` | writeReport |
| `isRecord` | 2276–2278 | shared util | |
| `clone` | 2280–2282 | shared util | |

`PromptResearchReceipt` interface (1726–1733) → `prompts.ts` (or shared types).

---

## 3. Current fan-in flow (research, write, verify)

Fan-in means: **do not expand the DAG until every sibling in a concurrent group has succeeded**. Implementation is two-layered:

1. **Primary path (current):** mark node `status=succeeded`, then **once** call `tryJoinAfterSuccess` → pure `evaluateJoin` / `siblingsByGroupKey` (`join-barrier.ts`). Research/write fan-in expands only on `all_succeeded`.
2. **Historical re-entry (removed):** after a concurrent batch, `reconcileCompletedBatch` (399–416) used to re-invoke `afterSuccess` once per group key. **Do not reintroduce** — success-path join replaces it.

### 3.1 Research fan-in → synthesis

| Step | Lines | Behavior |
| --- | ---: | --- |
| Batch dispatch | 369–373 | `pump` takes up to `MAX_CONCURRENT_RESEARCHERS` research nodes |
| Group key | 403–405, 410 | `researchGroupId` from node input; map key `research:{groupId}` |
| Sibling set | 669–671 | All research nodes with `sameResearchBatch` (same `researchGroupId`) |
| Gate | 671 | Every sibling is `succeeded` (or is the current node still completing) |
| Expansion | 690–699 | `queueSynthesis({ dependsOn: sibling ids, researchIds: prior+current, dryAuditPasses, … })` |
| Dry audit accounting | 686–696 | If `continuationMode === "audit"` and no new critical gaps/findings → `dryAuditPasses + 1`, else reset to `0` |
| Dedup | 853–858 | `queueSynthesis` skips if equivalent active synthesis already exists |

**Entry points that create research groups:**

- Initial surveys: `queueInitialSourceSurveys` 775–784 → `queueResearch` with batch `0`, mode `"initial"`
- Supplemental: `queueSupplementalResearch` 786–802
- Coverage audit: `queueCoverageAudit` 804–826
- Structural: `queueStructuralResearch` 869–881 → wraps `queueCoverageAudit` with `mode: "structural"`, `dryAuditPasses: 0`

### 3.2 Write fan-in → verification

| Step | Lines | Behavior |
| --- | ---: | --- |
| Batch dispatch | 381–383 | Up to `MAX_CONCURRENT_WRITERS` write nodes |
| Group key | 406–407, 410 | `writeGroupId`; map key `write:{groupId}` |
| Per-write checks | 718–732 | Submit page/sha256 match; repair no-progress → `markTerminalRun("blocked", …)` |
| Sibling set | 733–734 | All writes with same `writeGroupId` |
| Gate | 734 | All siblings succeeded |
| Expansion | 735 | `queueVerification(sibling ids, synthesisNodeId)` |
| Verification enqueue | 937–950 | Materialize indexes; queue **validate** + **review** sharing `verificationGroupId` |

**Write groups created by:**

- Draft wave: `queuePageWriters` 883–935 (`writeGroupId = write:{id}`; overview depends on content writers)
- Repair wave: `queuePageRepairs` 1014–1089 (`writeGroupId = repair:{id}`)

### 3.3 Verify fan-in → repair / structural / finalize

| Step | Lines | Behavior |
| --- | ---: | --- |
| Batch dispatch | 375–379 | All runnable `validate` **or** `review` nodes together |
| Group key | 408–410 | `verificationGroupId`; map key `validate:{groupId}` (review mapped as validate) |
| afterSuccess | 739–750 | Parse result; both kinds call `maybeCompleteVerification` |
| Pair gate | 957–962 | Both validate and review present and succeeded |
| Downstream gate | 963–964 | Skip if something already depends on both (idempotent) |
| No-progress blocks | 968–975 | Same validation issues / review defects as previous round → blocked |
| Unroutable | 977–980 | Global non-structural issues without page → blocked |
| Structural path | 987–1000 | Topology/coverage/spec-page/wiki-index/cross-link → `queueStructuralResearch` (budgeted) |
| Page path | 1003–1009 | Collect page paths → `queuePageRepairs` |
| Clean path | 1011 | `queueNode("finalize", …)` |

**Note (historical; removed):** `reconcileCompletedBatch` used to collapse review into the validate group key (`node.kind === "review" ? "validate" : node.kind`) so only one `afterSuccess` re-entry ran per verification pair. Current verify peer completion uses `maybeCompleteVerification` after self is marked succeeded — no batch reconcile.

---

## 4. `ensureResearchRoundAvailable` and `dryAuditPasses`

### 4.1 `ensureResearchRoundAvailable` (1091–1096)

```ts
private ensureResearchRoundAvailable(nextRound: number): void {
  const maxResearchRounds = this.requireRun().maxResearchRounds;
  if (nextRound >= maxResearchRounds) {
    throw new Error(`Research reached the ${maxResearchRounds}-round limit before coverage saturated`);
  }
}
```

**Semantics:**

- `run.maxResearchRounds` set at `start` via `validMaxResearchRounds` (124, 2257–2261); default `DEFAULT_MAX_RESEARCH_ROUNDS = 6` (58); allowed range 3–20.
- Callers pass `nextRound = parent.supplementalBatch + 1` (research batch index about to run).
- Throws plain `Error` when `nextRound >= maxResearchRounds` (i.e. batch index would leave the allowed round window).

**Call sites:**

| Site | Lines | Context |
| --- | ---: | --- |
| `queueSupplementalResearch` | 788 | Before expand research |
| `queueCoverageAudit` | 806 | Before audit research |
| `ensureSynthesisSubmissionFitsRun` (expand) | 1109 | Submit-time preflight so model cannot expand past budget |

### 4.2 `dryAuditPasses` logic

**Constant:** `REQUIRED_DRY_COVERAGE_AUDITS` from policy (default **1**).

**Carried on node inputs:**

- Research: `ResearchNodeInput.dryAuditPasses` (1720)
- Synthesis: `SynthesisNodeInput.dryAuditPasses` (1739) / `QueueSynthesisInput` (1753)

**How the counter advances (research fan-in, 686–696):**

1. After a full research group succeeds, compute `auditDry`:
   - `continuationMode === "audit"`, **and**
   - every current receipt has `criticalGapSignatures.length === 0`, **and**
   - every critical finding in those receipts already existed in `priorResearchIds` critical set.
2. When queuing synthesis:
   - if `auditDry` → `dryAuditPasses: researchInput.dryAuditPasses + 1`
   - else → `dryAuditPasses: 0` (reset)

**How synthesis consumes it (703–716):**

1. If `decision === "expand"` → supplemental research; return (does not require dry passes).
2. Else if `input.dryAuditPasses < REQUIRED_DRY_COVERAGE_AUDITS` → `queueCoverageAudit` (another audit research round), return.
3. Else → `queuePageWriters` (coverage saturated).

**Propagation of the counter into audit research (804–825):**

- `queueCoverageAudit` passes `parent.dryAuditPasses` into `queueResearch` so the next audit wave inherits the current count (increment happens only after a dry audit batch succeeds).

**Resets to 0:**

- Supplemental expand path: `queueSupplementalResearch` always passes `0` (800)
- Structural re-plan: `queueStructuralResearch` sets `dryAuditPasses: 0` (877)
- Non-dry audit research fan-in: reset in `afterSuccess` research case (696)

**Prompt surface:** `synthesisContext` exposes `dryCoverageAudits` / `requiredDryCoverageAudits` (1584–1585).

---

## 5. Plain `Error` throws for budget / block reasons

Focus: **budget or terminal-block policy** expressed as `throw new Error(...)` (not `markTerminalRun`, not protocol/context-budget classes). These failures typically surface via `executeNode` catch → `classifyNodeFailure` or fail the submit tool / pump.

### 5.1 Explicit research-round budget

| Lines | Message pattern | Site |
| ---: | --- | --- |
| **1094** | `Research reached the ${maxResearchRounds}-round limit before coverage saturated` | `ensureResearchRoundAvailable` |
| **1109** | (same, via call) | `ensureSynthesisSubmissionFitsRun` on expand |
| **788, 806** | (same, via call) | `queueSupplementalResearch` / `queueCoverageAudit` |

### 5.2 Coverage / finalize policy that blocks synthesis

| Lines | Message | Site |
| ---: | --- | --- |
| **1169** | `WikiSpec cannot finalize with ${criticalGapCount} unresolved critical research gap(s)` | `ensureSynthesisSpecReceipts` |

### 5.3 Related submit-time contract throws (block expansion, not numeric budgets)

These are plain `Error`s that prevent graph progress when agents violate contracts:

| Lines | Message | Site |
| ---: | --- | --- |
| 1127 | Supplemental research scope repeats existing scope | `ensureNewResearchScopes` |
| 1135 | Supplemental research scope targets undeclared source | `ensureResearchSourcePaths` |
| 1148–1158 | WikiSpec finding select/omit/critical rules | `ensureSynthesisSpecReceipts` |
| 1981 | Review defect targets unknown page | `ensureReviewTargets` |

### 5.4 `maxResearchRounds` config validation

| Lines | Message | Site |
| ---: | --- | --- |
| 2259 | `maxResearchRounds must be an integer from 3 to 20` | `validMaxResearchRounds` (start-time) |

### 5.5 Not plain `Error`, but same budget/block *policy* (for extraction awareness)

These use `markTerminalRun("blocked", …)` instead of throw — keep behavior when extracting:

| Lines | Reason |
| ---: | --- |
| 426–430 | Node hit `MAX_NODE_ATTEMPTS` (3) |
| 729 | Repair made no change (`checkNoProgress`) |
| 755 | Source fingerprint changed twice (`sourceRestartCount >= 1`) |
| 969 | Validation same unresolved issue set twice |
| 973 | Review same unresolved defect set twice |
| 979 | Unroutable global validation safety issue |
| 996–997 | Structural resynthesis exceeded `MAX_STRUCTURAL_RESYNTHESES` (1) |
| 1030 | Local repair exceeded `MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN` (3) |

Also caught, not thrown here: `WikiAgentContextBudgetError` (490–492) — classified by `classifyNodeFailure`.

---

## 6. Dependencies between `afterSuccess` cases

```
inspect
  └─► queueInitialSourceSurveys → research (batch 0, group G0)
        └─► [research fan-in]
              └─► queueSynthesis (mode initial|supplemental|structural|audit)

synthesis
  ├─ decision "expand"
  │    └─► queueSupplementalResearch → research (batch+1)
  │          └─► (loops back to research fan-in → synthesis)
  ├─ dryAuditPasses < REQUIRED_DRY_COVERAGE_AUDITS (default 1)
  │    └─► queueCoverageAudit → research (audit)
  │          └─► (research fan-in may increment dryAuditPasses)
  └─ dry audits satisfied
       └─► queuePageWriters → write nodes (+ overview after content)

write
  ├─ invalid submit / sha mismatch → throw Error (node fails)
  ├─ repair no-progress → markTerminalRun blocked
  └─ [write fan-in]
       └─► queueVerification → validate + review (parallel)

validate ──┐
           ├─► maybeCompleteVerification (pair fan-in)
review ────┘
              ├─ same issues/defects twice → blocked
              ├─ unroutable global issues → blocked
              ├─ structural (validation codes or topology/coverage defects)
              │    ├─ resynthesis budget exhausted → blocked
              │    └─► queueStructuralResearch → audit research (mode structural)
              │          └─► research fan-in → structural synthesis
              │                └─► (writers with structural feedback)
              ├─ page-local issues/defects
              │    ├─ repair round budget exhausted → blocked
              │    └─► queuePageRepairs → write (repair) → write fan-in → verify again
              └─ clean
                   └─► finalize

finalize
  ├─ sourceDrift
  │    ├─ sourceRestartCount >= 1 → blocked
  │    └─ else invalidate all + queue inspect (restart)
  └─ else markTerminalRun succeeded
```

### Case-by-case dependency notes

| Case | Depends on prior cases / state | Downstream |
| --- | --- | --- |
| **inspect** | Fresh run or source-drift restart | Sets `run.inspection*`, `effectiveMode`; only entry to research |
| **research** | Siblings share `researchGroupId`; uses `priorResearchIds` / `continuationMode` / `dryAuditPasses` from enqueue | Only queues synthesis when **all** siblings succeeded |
| **synthesis** | Requires finalized research receipts on deps; expand uses `ensureResearchRoundAvailable` at submit time | Expand ↔ research loop; audit loop; or writers |
| **write** | Needs finalized synthesis spec + research deps; overview waits on content writes | Only queues verification when **all** `writeGroupId` siblings succeeded |
| **validate / review** | Share `verificationGroupId`; review re-checked by `ensureReviewSubmissionFitsRun` | Neither alone advances; pair completion drives repair/structural/finalize |
| **finalize** | Depends on clean verify pair; re-inspects git fingerprint | Terminal success or full graph restart |

### Cross-cutting dependency edges extractors must preserve

1. **`queueNode` / `newNode`** shared by run-service (`start`) and every transition.
2. **`markTerminalRun` + `emitPendingTerminalEvent`** — transitions set blocked reasons; coordinator flushes events after pump steps.
3. **`tryJoinAfterSuccess` / `evaluateJoin` (replaces historical `reconcileCompletedBatch` → `afterSuccess`)** — join must stay success-path-only and idempotent (synthesis dedup, verification downstream gate, existing verification/write groups). `reconcileCompletedBatch` is **historical; removed**.
4. **Submit-time validators** (`validateControlSubmission`) run during execute, but encode transition budgets (research rounds, finding coverage).
5. **Structural path resets dry audits** while **audit path accumulates** them — do not merge those modes carelessly.
6. **Repair vs draft writers** share write fan-in + verification, but repair adds `checkNoProgress` / `beforeSha256` and a per-plan round budget.

---

## 7. Suggested extraction order (for later agents)

1. **Pure utils + node-input parsers** (no behavior change; reduce import cycles).
2. **`prompts.ts`** — free functions only; coordinator keeps call site.
3. **`handoffs.ts`** — artifact store methods + `writeReport` / `artifactKindForNode`.
4. **`transitions.ts`** — `afterSuccess` + all `queue*` + ensure* (largest semantic chunk).
5. **`coordinator.ts`** — pump/execute; call into transitions/prompts/handoffs.
6. **`run-service.ts`** — lifecycle; call schedule + invalidate + handoff fork copy.
7. **Facade thin class** — hold state, bind modules with a shared `EngineContext` or keep methods as delegated wrappers.

**Do not change:** concurrency limits, dry-audit requirement (2), research-round inequality (`>= max`), structural resynthesis budget (1), repair rounds (3), fan-in group keys, or deferred terminal event timing.

---

## 8. Quick reference — method index by target

```
facade:        constructor, emit, nodeById, requireNode, requireRun, now, newId
run-service:   start, getSnapshot, listSnapshots, subscribe, serialize, restore,
               retryNode, retryPhase, forkAndRetryNode, forkAndRetryPhase,
               forkAndRetry, retryRoots, pause, resume, cancel, interrupt,
               waitForIdle, reconcileGitInputs, invalidateFrom, invalidateFromMany,
               abortControllers
coordinator:   schedule, pump, executeBatch, runnableNodes,
               executeNode, executeNodeWork, updateActivity, updateOutput, updateHistory,
               emitActivity, archiveAttempt, markTerminalRun, emitPendingTerminalEvent,
               failRun
               # historical; removed: reconcileCompletedBatch (fan-in now tryJoinAfterSuccess)
transitions:   afterSuccess, queueInitialSourceSurveys, queueSupplementalResearch,
               queueCoverageAudit, queueResearch, queueSynthesis, queueStructuralResearch,
               queuePageWriters, queueVerification, maybeCompleteVerification,
               queuePageRepairs, ensureResearchRoundAvailable, validateControlSubmission,
               ensureSynthesisSubmissionFitsRun, ensureReviewSubmissionFitsRun,
               ensureNewResearchScopes, ensureResearchSourcePaths, ensureSynthesisSpecReceipts,
               queueNode, newNode, previousReviewSignature, previousValidationSignature
handoffs:      persistNodeHandoff, artifactWritePathForNode, researchReceiptsForNode,
               ensureArtifactStore, requireArtifactStore, copyArtifactsForFork
prompts:       (free functions only — promptFor and context builders)
```
