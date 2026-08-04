# Generate

**Job:** write Staging Wiki concept pages for the **sealed Spec page set** into `wiki/`.
**Prereq:** plan complete; `ow gate plan` passed; Spec at `analysis/spec.json` (or sealed
`inputs/spec.json`) is the sole page-set authority.
**Next:** review (`skill/references/review.md`), then `ow validate --run <runId>`.

## Spec-bound only (do not re-plan)

You are **not** re-discovering or redesigning the wiki page tree.

1. Read `analysis/spec.json` or `inputs/spec.json`. The `pages` list (especially `critical: true`)
   is the write checklist.
2. When present, read discovery-map and `analysis/receipts/*` for evidence **paths** — supporting
   only; not Spec authority.
3. Re-open load-bearing spans under `sources/` as needed. Do not invent citations or line numbers.
4. For each Spec concept path, select matching
   `skill/templates/{overview,architecture,module,flow,concept}.md`, adapt it, and write under
   `wiki/`. Prefer Spec directory layout (`modules/`, `flows/`, …).
5. Cross-link related Spec pages with relative `.md` links.
6. Do **not** hand-write durable `index.md` / `log.md` as concept pages — host regenerates every
   directory `index.md` (`ow validate` regenerates indexes).

## Frontmatter and language

- Required: non-empty `type`, `title`, `description` (OKF v0.2).
- Optional: `tags`.
- **Never** write `generated`, `verified`, `stale_after`, `okf_version`.
- Prose language follows `wikiLanguage` (`en` | `zh`). Paths and citations stay untranslated.

## Citations

Place verified Source Citations beside the facts they support:

- Single: `repo:path#L1-L2`
- Multi: `repo:id/path#L1-L2`
- Never invent line ranges; never use a `sources/` prefix inside `repo:`.

## Fail-closed completeness

Generation is complete only when every **critical** Spec concept path exists under `wiki/`, answers
its reader question, is grounded by nearby verified citations, and a new reader can enter at
`overview.md` (or Spec narrative path). Missing critical pages → fail; do not claim success.

Do **not**:

- Draft a new page set from a fresh repository survey
- Add concept pages absent from the Spec
- Treat DiscoveryMap or research receipts as Spec authority
