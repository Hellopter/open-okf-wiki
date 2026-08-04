# Plan

Shape the complete `analysis/spec.json` before any candidate page is written.

**Inputs:** `inputs/inventory.json`, `analysis/discovery-map.json` (or the input shell), and survey
receipts under `analysis/receipts/`.
**Output:** `analysis/spec.json`.
**Mandatory stop:** run `ow gate plan --run <runId>` after planning. Do not enter Write unless it
succeeds.

## Required Spec shape

```json
{
  "version": 1,
  "title": "Example service",
  "overviewPath": "overview.md",
  "wikiLanguage": "en",
  "domains": [
    { "id": "domain:auth", "title": "Authentication", "coverageUnitIds": ["app"] }
  ],
  "pages": [
    {
      "path": "overview.md",
      "type": "Overview",
      "title": "Example service",
      "question": "What does this service do and how is it organized?",
      "critical": true,
      "coverageUnitIds": ["app"]
    }
  ],
  "coverageCancellations": []
}
```

Every page needs a reader purpose and inspected evidence. Bind every required inventory coverage
unit via page/domain `coverageUnitIds`, or add a `coverageCancellations` entry with
`coverageUnitId`, `cancelled: true`, and a non-empty `reason`. Legacy `sourceCoverage` and
`surfaceCoverage` forms remain accepted when their id and reason are equally explicit.

For multiple sources, plan a repository/surface map plus either a `crossSource: true` Discovery Map
flow, a domain that binds multiple units, or `crossSourceFlowCancellation` with
`cancelled: true` and a non-empty `reason`.

Do not list `index.md` or `log.md` as pages. Spec paths must remain below `candidate/` and cannot
contain an absolute or traversal path. The package's `schemas/spec.schema.json` is the
machine-readable reference contract.

## Gate failure

Repair the Discovery Map or Spec, then rerun `ow gate plan`. The gate receipt is invalidated whenever
the inventory, Discovery Map, or Spec changes. Use `ow retry --from discover|plan` only when
discarding the corresponding derived artifacts is intended.
