# Generate

**Job:** write Staging Wiki concept pages for the **sealed Spec page set** into an empty (or fixture-seeded empty) `wiki/`.
**Prereq:** plan complete; sealed Spec at `inputs/spec.json` is the sole page-set authority.
**Next:** review (`skill/references/review.md`).

## Spec-bound only (do not re-plan)

You are **not** re-discovering or redesigning the wiki page tree. Plan already fixed domains/pages.

1. Read `inputs/spec.json`. The `pages` list (critical paths especially) is your write checklist.
2. When present, read `inputs/discovery-map.json` (or `analysis/discovery-map.json`) for evidence paths,
   domain/flow/concept hints — **supporting evidence only**, not a license to invent extra concept pages.
3. Read `inputs/evidence/index.json` and `inputs/evidence/receipts/*` when projected; re-open load-bearing
   `sources/` spans as needed. Do not invent citations.
4. For each Spec concept path, select the matching
   `skill/templates/{overview,architecture,module,flow,concept}.md`, adapt it, and write under `wiki/`
   with `write` / `edit`. Prefer Spec directory layout (`modules/`, `flows/`, …).
5. Cross-link related Spec pages. Do **not** plan or hand-write `index.md` / `log.md` as concept pages;
   the product regenerates every directory's `index.md` as a mechanical progressive-disclosure listing.
6. Proceed to the review reference.

Do **not**:

- Draft a new page set from a fresh repository survey
- Add concept pages that are not in the Spec
- Treat DiscoveryMap or research receipts as Spec authority

Generation is complete when every **critical Spec concept path** exists under `wiki/`, answers its
reader purpose, is grounded by nearby verified Source Citations, and a new reader can enter at
`overview.md` (or the Spec narrative path) and navigate via multi-level mechanical indexes.
