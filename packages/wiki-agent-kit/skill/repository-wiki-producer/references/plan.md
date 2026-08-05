# Plan

Shape the complete `analysis/spec.json` before any candidate page is written.

**Inputs:** `inputs/inventory.json`, `analysis/discovery-map.json`, and survey receipts under
`analysis/receipts/`.
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
`coverageUnitId`, `cancelled: true`, and a non-empty `reason`.

Copy `wikiLanguage` from `inputs/run-policy.json` into the Spec top-level field. Write every page
`title` and `question` in that language (`zh` → Simplified Chinese prose; identifiers stay as-is).

For multiple sources (`sourceCount >= 2` / tier L3), do **not** collapse into a thin overview:

1. Plan a critical `overview.md` that includes a repository/surface map naming every source.
2. Plan Architecture and/or per-source Module pages so each source is substantively bound via
   `coverageUnitIds` (not merely listed).
3. Plan at least one critical cross-source `Flow` page with multi-source evidence, **or** set
   `crossSourceFlowCancellation` with `cancelled: true` and a non-empty `reason`.
4. Also satisfy the Discovery Map rule: a `crossSource: true` flow, a multi-unit domain, or the
   cancellation above.
5. Aim for depth: at least `max(3, sourceCount + 1)` Spec pages for multi-source runs.

Do not list `index.md` or `log.md` as pages. Spec paths must remain below `candidate/` and cannot
contain an absolute or traversal path. The package's `schemas/spec.schema.json` is the
machine-readable reference contract.

## Gate failure

Repair the Discovery Map or Spec, then rerun `ow gate plan`. The gate receipt is invalidated whenever
the inventory, Discovery Map, or Spec changes. Use `ow retry --from plan` only when discarding the
planning artifacts is intended.
