# Generate

Write the Spec-bound concept pages into the unsealed `candidate/` directory.

**Prerequisites:** `analysis/spec.json` exists and `ow gate check --run <runId>` succeeds.
**Authority:** the `pages` array in `analysis/spec.json` is the sole page-set authority.
**Next:** independent review, then `ow validate --run <runId>`.

Also read:

- `references/chinese-writing.md` when wiki language is `zh` / `zh-CN`
- `references/okf-profile.md` for frontmatter and reserved-file rules
- `references/project-model.md` when resolving `knowledgeIds`

## Procedure

1. Read the full Spec plus `analysis/project-model.json` and relevant Discovery Map/receipt paths.
   Do not re-plan from a fresh survey.
2. Re-open evidence spans inside `sources/<id>/` as needed.
3. For each Spec page, adapt the matching template and write only below `candidate/`.
4. Honor `requiredSections` as exact Markdown headings the host will check.
5. Cross-link candidate pages with relative `.md` links.
6. Leave `index.md` and `log.md` to the host; validation regenerates every `index.md`.

Every critical Spec path must exist, answer its stated reader question, and have nearby verified
evidence. Do not add a concept page absent from the Spec or change the Spec while writing.

## Frontmatter and local links

Each concept page needs non-empty YAML `type`, `title`, and `description`. `tags` are optional.
Never write `generated`, `verified`, `stale_after`, or `okf_version` on concept pages. Do not invent
timestamps or human-review claims.

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
