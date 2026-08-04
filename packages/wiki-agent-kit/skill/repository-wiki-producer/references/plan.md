# Plan

Shape the **WikiRunSpec** and intended page set before writing Staging Wiki pages.

**Prereq:** discovery receipts and/or `inputs/inventory.json` surveyed; discovery-map filled when
tier requires it.
**Output:** `analysis/spec.json`
**Host gate (mandatory before write):** `ow gate plan --run <runId>`

## Authority

1. Read `inputs/inventory.json` (coverage units, tier, surfaces).
2. Read `analysis/discovery-map.json` or `inputs/discovery-map.json` when present — domains/flows
   are evidence for Spec shape, **not** a license to skip coverage bindings.
3. Read survey/semantic receipts under `analysis/receipts/` by **path** (JIT). Do not invent
   findings from chat paste.
4. Explore `sources/<id>/` from entry points toward implementation (not README-only). Enumerate
   **every** freeze source and distinct monorepo surface the inventory implies.

## Spec shape

Write a complete JSON document to **`analysis/spec.json`**:

```json
{
  "version": 1,
  "title": "…",
  "overviewPath": "overview.md",
  "wikiLanguage": "en",
  "domains": [
    {
      "id": "domain:auth",
      "title": "Auth",
      "coverageUnitIds": ["api", "api::packages/auth"]
    }
  ],
  "pages": [
    {
      "path": "overview.md",
      "type": "Overview",
      "title": "…",
      "question": "What is this product and for whom?",
      "critical": true,
      "coverageUnitIds": ["api"]
    }
  ],
  "sourceCoverage": [],
  "surfaceCoverage": [],
  "openQuestions": [],
  "changelog": "Initial plan"
}
```

Rules:

- Every intended page has a clear **reader purpose** (`question`) and enough inspected evidence.
- Bind every **required** coverage unit via `coverageUnitIds` (and/or projected `sourceIds` /
  `surfaceIds`) on pages or domains, **or** cancel via `sourceCoverage` / `surfaceCoverage` with
  `cancelled: true` and a non-empty `notes` reason. Silent omission fails the gate.
- Multi-source: plan an overview repository map and at least one cross-source flow (or cancel with
  an explicit open question). Use multi-id citations later (`repo:<id>/…`).
- Monorepo multi-package: treat each inventory surface as a unit; do not collapse unrelated packages
  into one vague page.
- Prefer fewest domains that still isolate independent evidence.
- Do **not** include `index.md` or `log.md` as Spec pages.
- Do **not** author `generated` / `verified` / `stale_after` anywhere.

## Multi-source protocol

When two or more directories exist under `sources/`:

- Survey **each** source before synthesizing the Spec.
- Bind or cancel every freeze source unit.
- Prefer domains by reader boundary, but scope text and `coverageUnitIds` must still name sources.

## Completion gate

- Every intended page has purpose + evidence to write.
- Every required coverage unit is bound or explicitly cancelled.
- DiscoveryMap domains/flows (when tier ≠ L0) support the page set; critical units are not missing.
- **Then** stop for host: `ow gate plan --run <runId>`. Do not write Wiki pages until the gate passes.

On gate failure: repair Spec or re-discover missing units (`ow retry --from discover|plan`). Do not
proceed to write with unbound critical coverage.
