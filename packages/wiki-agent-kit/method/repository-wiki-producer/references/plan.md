# Plan

Shape the complete `analysis/spec.json` before any candidate page is written.

**Inputs:** `inputs/inventory.json`, `analysis/discovery-map.json`, and survey receipts under
`analysis/receipts/`.
**Output:** `analysis/spec.json` and `analysis/page-assignments.json`.
**Mandatory stop:** publish `ow checkpoint --phase plan` after planning, then run
`ow gate plan --run <runId>`. Do not enter Write unless both succeed.

## Required Spec shape

```json
{
  "version": 2,
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
  "pageAssignments": [
    {
      "pagePath": "overview.md",
      "owner": "integration",
      "role": "integration",
      "coverageUnitIds": ["app"],
      "dependsOn": []
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

`pageAssignments` is mandatory. Every Spec path belongs to exactly one owner. Use source/domain
owners for source-specific pages and an `integration` owner for overview, navigation, glossary, and
cross-source Flow pages. Each assignment declares the coverage it owns and the handoff ids it needs;
do not give two owners the same path.

## Gate failure

Repair the Discovery Map or Spec, publish a replacement plan checkpoint, then rerun the gate. The
gate receipt and checkpoint are invalidated whenever inventory, Discovery Map, Spec, or assignments
change.
