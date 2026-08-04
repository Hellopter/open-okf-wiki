# Review

Independently verify the unsealed `candidate/` against the frozen sources and `analysis/spec.json`.
Do not edit candidate pages while acting as a reviewer.

Write per-lens findings beneath `analysis/receipts/review/`, then consolidate
`analysis/defects.json`:

```json
{
  "clean": false,
  "defects": [
    {
      "severity": "blocking",
      "code": "missing_page",
      "issue": "Critical Spec page modules/auth.md is missing",
      "path": "modules/auth.md"
    }
  ]
}
```

Severity is `blocking`, `major`, or `minor`. `clean` is true only when the defects array is empty.
The package's `schemas/defects.schema.json` records the reference shape.

## Check

- Every critical Spec page exists, has a distinct reader purpose, and is reachable from the narrative.
- Candidate `.md` links resolve within `candidate/`; host-generated indexes are not hand-authored.
- Claims are supported by nearby links into frozen `sources/` and their line ranges are real.
- Source targets are relative local Markdown links, never `repo:`, remote, `file://`, or editor URLs.
- Frontmatter has non-empty `type`, `title`, and `description`, without prohibited provenance fields.
- Multi-source flows identify each participating source/surface rather than collapsing them.
- Diagrams clarify real evidence and agree with prose.

Blocking and major defects require repair before the validator runs. `ow validate --run <runId>`
regenerates indexes, mechanically validates the candidate, and seals it. Do not alter a sealed
candidate; start a new write attempt with `ow retry --from write`.
