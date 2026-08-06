# Survey Unit Receipt

Read `inputs/run-policy.json`, the assigned inventory unit, and only frozen files under `sources/`. Write
one JSON receipt at the exact path supplied by the workflow. This document defines the worker-owned data
plane; the host independently validates it and adds its control envelope.

Required top-level fields are `coverageUnit`, `status`, `purpose`, `summary`, `entryPoints`, `modules`,
`runtimeFlows`, `contracts`, `evidence`, `plannerHints`, and `openQuestions`. Copy `coverageUnit.id`,
`kind`, `sourceId`, `path`, and `label` exactly from inventory. Do not add host-controlled envelope fields.

- `status: "ok"` requires a non-empty purpose and at least one evidence span. Otherwise use `failed` or
  `skipped` and provide `insufficiency: {code,retryable,reason}`.
- Each evidence item is `{id,path,startLine,endLine,summary}`. `path` begins `sources/<sourceId>/`; line
  ranges are real 1-based lines in frozen regular files. At most 16 evidence spans, 24 modules, 8 flows,
  6 questions, and 48 KiB total receipt bytes are accepted.
- A `source` unit indexes entry points, build topology, surfaces, and cross-surface contracts. Its
  `relatedCoverageUnitIds` exactly lists its child surface units; do not deep-dive those surfaces.
- A `surface` unit reads only `sources/<sourceId>/<path>/` and must not include
  `relatedCoverageUnitIds`.
- `plannerHints` contains bounded `domains` and `flows` items with `id`, `summary`, optional evidence IDs,
  optional `coverageUnitIds`, and optional `crossSource` for flows. These are merged mechanically.

Keep human-readable fields in `wikiLanguage`; do not create a Discovery Map, artifact list, or candidate
page.
