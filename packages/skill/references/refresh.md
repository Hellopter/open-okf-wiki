# Refresh

**Job:** update an existing Staging Wiki against the current Repository Snapshot Set **within the sealed Spec page set**.
**Prereq:** plan complete; `inputs/spec.json` is page-set authority; `wiki/` already has prior pages.
**Next:** review (`skill/references/review.md`).

## Spec-bound only (do not re-plan)

Treat the existing Staging Wiki as useful prose context, **not** as Spec authority. The sealed Spec
decides which concept paths must exist.

1. Read `inputs/spec.json` and reconcile every Spec concept path against current `sources/`.
2. When present, read `inputs/discovery-map.json` and `inputs/evidence/*` for evidence paths —
   supporting only; do not invent Spec-external concept pages.
3. Preserve structure and prose that remain useful and accurate for Spec paths. Correct stale facts
   and citations; remove or merge content whose Spec purpose disappeared. Prefer directory paths
   (`modules/`, `flows/`, …) for related concept pages. Do not maintain hand-written `index.md`
   files as durable TOC — the product regenerates directory listings mechanically after write/repair
   and at publish.
4. After every Spec-driven page change, ensure concept pages still cross-link correctly and the
   directory layout still exposes hierarchy; no old statement survives merely because its source
   file was untouched.
5. Proceed to the review reference after the whole Wiki reflects the current snapshot **and Spec**.

Do **not** redesign the page tree in generate/refresh — that is Plan (or plan revise) work.

Refresh is complete when every **critical Spec concept path** still earns its place (or is
explicitly out of Spec), all current important Spec ideas are navigable via the narrative overview
and multi-level mechanical indexes, and no content depends on the previous publication being correct.
