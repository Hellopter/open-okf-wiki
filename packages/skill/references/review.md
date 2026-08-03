# Review

**Job:** independently verify the Staging Wiki; blocking defects must be repaired before completion.
**Prereq:** concept pages exist under `wiki/` (after generate or refresh).
**Next:** repair via earlier plan/write steps, or fail the run if unclean after repair rounds.

## Handoff (required)

Call the `submit_defect_report` tool with a typed DefectReport. Product validates
`DefectReportSchema` and atomically writes `analysis/defect-report.json`.

- **That path is the only admission path.** Free-text chat JSON is never accepted as success.
- Call exactly once when the seat verdict is ready.
- `clean=true` only with empty `defects`; `clean=false` requires ≥1 defect with
  `severity` / `code` / `issue` (`severity` is `blocking` | `major` | `minor`).
- Stamp `reviewerId` to the seat lens (e.g. `grounding`, `coverage`, `consistency`, `general`).

Do **not** paste DefectReport JSON into assistant text as a substitute for the tool.

## What to verify

Review the Wiki as both a first-time reader and a source verifier. Repair before completing:

- unclear purpose, audience, or terminology on concept pages (especially the narrative overview)
- navigation that cannot walk multi-level progressive disclosure (parent `index.md` → subdirectory
  `index.md` → concept pages). Do **not** fail solely because the model did not hand-craft indexes —
  the Run Boundary materializes mechanical listings. Still fail on unreachable concepts, broken
  cross-links, or missing critical pages
- an important boundary, module, flow, or concept that readers need but cannot find
- pages or sections that are thin, duplicated, stale, or better merged or split
- claims that overstate the cited source, citations too far from their claims, or pages without
  resolved Source Citations
- broken cross-links, orphan pages, heading mismatches, raw HTML, invalid frontmatter, or temporary
  artifacts
- diagrams that add no clarity or disagree with prose and source

Complete only when every manifest concept page exists, has a distinct reader purpose, is reachable
from the Wiki narrative (overview + directory structure), and passes this review without a known
defect — reported only via `submit_defect_report`.
