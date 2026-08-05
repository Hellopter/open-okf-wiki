# Generate

Write only the owner-scoped, Spec-bound concept pages into the unsealed `candidate/` directory.

**Prerequisites:** `analysis/spec.json` exists and `ow gate check --run <runId>` succeeds.
**Authority:** the `pages` array in `analysis/spec.json` is the sole page-set authority.
**Next:** independent review, then `ow validate --run <runId>` followed by the terminal validate
checkpoint.

## Procedure

1. Read `inputs/run-policy.json` for `wikiLanguage` / `focus`, then the full Spec and the relevant
   Discovery Map/receipt paths. Do not re-plan from a fresh survey.
2. Re-open evidence spans inside `sources/<id>/` as needed.
3. Read `analysis/page-assignments.json`. Write only the paths owned by your shard; never edit a
   path owned by another shard.
4. Write all prose (title, description, headings, body) in `wikiLanguage`. When `wikiLanguage=zh`,
   use Simplified Chinese throughout; keep paths and identifiers untranslated.
5. Cross-link candidate pages with relative `.md` links.
6. Leave `index.md` and `log.md` to the host; validation regenerates every `index.md`.

Every critical Spec path must exist, answer its stated reader question with concrete evidence-backed
depth (not a README restatement), and have nearby verified Source Citations. For multi-source runs,
the overview repository map, per-source module/architecture coverage, and any critical cross-source
flow must name participating `sources/<id>/` trees with stage-level citations. Do not add a concept
page absent from the Spec or change the Spec while writing. Write a handoff proposal listing the
exact pages, evidence receipts, and unresolved dependencies after the shard finishes.

## Frontmatter and local links

Each concept page needs non-empty YAML `type`, `title`, and `description`. `tags` are optional.
Never write `generated`, `verified`, `stale_after`, or `okf_version`.

Link a factual claim directly to its frozen source file with a real line range. The link target is
relative to the page being written:

```md
<!-- candidate/overview.md -->
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)

<!-- candidate/modules/auth.md -->
[Source: src/A.java L10-L20](../../sources/app/src/A.java#L10-L20)
```

Do not use `repo:`, remote URLs, `file://`, `vscode://`, a plain source path without `#Lx-Ly`, or
any target outside frozen `sources/`. The line range must come from an actual read, never an estimate.
