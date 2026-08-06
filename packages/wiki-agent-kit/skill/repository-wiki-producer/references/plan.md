# Plan

Shape the complete `analysis/spec.json` before any candidate page is written.

**Inputs:** `inputs/inventory.json`, `analysis/project-model.json`, `analysis/discovery-map.json`,
and survey receipts under `analysis/receipts/`.
**Output:** `analysis/spec.json`.
**Mandatory stop:** run `ow gate plan --run <runId>` after planning. Do not enter Write unless it
succeeds.

Read `references/project-model.md` if the model shape is unclear. The Project Knowledge Model is the
main semantic input; inventory and discovery receipts supply coverage and evidence binding.

## Required Spec shape

```json
{
  "version": 1,
  "title": "Example service",
  "overviewPath": "overview.md",
  "wikiLanguage": "zh",
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
      "audiences": ["new-engineer", "llm"],
      "requiredSections": ["业务目标", "最小心智模型", "阅读路径", "已知缺口"],
      "knowledgeIds": ["domain:auth", "capability:login"],
      "evidenceIds": ["evidence:app:readme"],
      "coverageUnitIds": ["app"]
    }
  ],
  "coverageCancellations": []
}
```

Every page needs:

| Field | Rule |
|---|---|
| `path` / `type` / `title` | Stable page identity |
| `question` | Reader question the page must answer |
| `critical` | Gate/validate enforce critical pages |
| `audiences` | Non-empty reader audiences |
| `requiredSections` | Headings the writer must produce |
| `knowledgeIds` | Project Model object ids this page explains |
| `evidenceIds` | Evidence ids the page will cite |
| `coverageUnitIds` | Inventory units bound by the page |

Bind every required inventory coverage unit via page/domain `coverageUnitIds`, or add a
`coverageCancellations` entry with `coverageUnitId`, `cancelled: true`, and a non-empty `reason`.

For multiple sources, plan a repository/surface map plus either a `crossSource: true` Discovery Map
flow, a domain that binds multiple units, or `crossSourceFlowCancellation` with
`cancelled: true` and a non-empty `reason`.

Choose templates from `templates/` according to page type (`business-process.md`,
`business-domain.md`, `data-model.md`, `known-gap.md`, and the existing overview/module templates).

Do not list `index.md` or `log.md` as pages. Spec paths must remain below `candidate/` and cannot
contain an absolute or traversal path. The package's `schemas/spec.schema.json` is the
machine-readable reference contract.

## Gate failure

Repair the Discovery Map, Project Model, or Spec, then rerun `ow gate plan`. The gate receipt is
invalidated whenever the inventory, Discovery Map, Project Model, or Spec changes. Use
`ow retry --from plan` only when discarding the planning artifacts is intended.
