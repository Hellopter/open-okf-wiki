# Review

Independently verify the unsealed `candidate/` against the frozen sources and `analysis/spec.json`.
Do not edit candidate pages while acting as a reviewer.

Write page evidence and global-lens findings beneath `analysis/receipts/review/`, then consolidate
`analysis/defects.json`. Every defect must name its owner and a stable fingerprint:

```json
{
  "version": 2,
  "clean": false,
  "defects": [
    {
      "severity": "blocking",
      "code": "missing_page",
      "category": "coverage",
      "issue": "Critical Spec page modules/auth.md is missing",
      "pagePath": "modules/auth.md",
      "owner": "source:api",
      "fingerprint": "missing_page:modules/auth.md",
      "evidence": ["Spec marks modules/auth.md as critical."],
      "repairSuggestion": "Create the assigned page with frozen-source citations."
    }
  ]
}
```

Severity is `blocking`, `major`, or `minor`. `clean` is true only when the defects array is empty.
The package's `schemas/defects.schema.json` records the reference shape.

## Check

- Every critical Spec page exists, has a distinct reader purpose, and is reachable from the narrative.
- Candidate prose matches `wikiLanguage` from `inputs/run-policy.json` (`zh` → Simplified Chinese). A
  mostly-English candidate when `wikiLanguage=zh` is a major (or blocking) `language_mismatch`.
- Candidate `.md` links resolve within `candidate/`; host-generated indexes are not hand-authored.
- Claims are supported by nearby links into frozen `sources/` and their line ranges are real.
- Source targets are relative local Markdown links, never `repo:`, remote, `file://`, or editor URLs.
- Frontmatter has non-empty `type`, `title`, and `description`, without prohibited provenance fields.
- Multi-source flows identify each participating source/surface rather than collapsing them.
- Multi-source candidates are deep, not thin: repository/surface map present, each source has
  substantive cited coverage, and cross-source journeys are evidence-backed (`thin_multi_source`
  when reduced to slogans).
- Diagrams clarify real evidence and agree with prose.

Blocking and major defects require owner-scoped repair before the validator runs. A repair loop may
run at most twice and must stop when its defect fingerprint repeats or it makes no progress.
`ow validate --run <runId>` regenerates indexes, mechanically validates the candidate, and creates
the candidate manifest. The subsequent `validate` checkpoint seals only a clean current review leaf.
