# Review

**Job:** independently verify the Staging Wiki; blocking defects must be repaired before completion.
**Prereq:** concept pages exist under `wiki/` after generate.
**Next:** repair via earlier plan/write steps, or fail the run if unclean after repair rounds.
**Host check:** `ow validate --run <runId>` (regenerates indexes + mechanical citation resolve).

## Defect report

Write structured defects to `analysis/defects.json` (and optional per-lens receipts under
`analysis/receipts/review/`). Return only a short envelope to the orchestrator:

```json
{
  "status": "ok",
  "path": "analysis/defects.json",
  "summary": "clean|N blocking, M major"
}
```

Example defect file:

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

`severity` is `blocking` | `major` | `minor`. `clean: true` only with empty `defects`.

## What to verify

- Unclear purpose, audience, or terminology (especially overview)
- Navigation: overview + directory structure reach every concept; host materializes `index.md` —
  do not fail solely for missing hand-written indexes; **do** fail on unreachable concepts, broken
  cross-links, or missing critical Spec pages
- Important boundary, module, flow, or concept readers need but cannot find
- Thin, duplicated, or stale pages better merged or split
- Claims that overstate the cited source; citations too far from claims; pages without resolved
  Source Citations
- Invented line ranges, `sources/` prefix inside `repo:`, or multi-source pages missing source ids
- Broken frontmatter (missing `type` / `title` / `description`) or prohibited provenance fields
  (`generated`, `verified`, `stale_after`)
- Diagrams that add no clarity or disagree with prose and source

## Completion

Complete only when every critical Spec page exists, has a distinct reader purpose, is reachable from
the narrative entry, citations resolve under freeze sources, and review is clean (or only non-blocking
minors remain per operator policy). Otherwise repair or fail — preserve prior published wiki if any.
