# Per-page Writing And Repair

Edit only the single `wiki/` page named in the WikiPagePacket. Every target
page, including Overview, needs non-empty `type`, `title`, `description`, and
`sources` frontmatter. Each source is an object with a page-unique, stable `id`
and a `resource` in the form `repo:<project>/<path>#Lx-Ly`. `tags` is optional
and, when present, is a non-empty string array. Cite each load-bearing body
claim with its OKF source ID as `[^source-id]`. Map the assigned page type
exactly to frontmatter `type`: `Overview`, `Domain`, `Architecture`, `Module`,
`Flow`, `Concept`, `State`, or `Data`. Define every source footnote with a Markdown link to the exact
matching `repo:` resource. Research evidence uses `project/path#Lx-Ly`;
wiki citations use `repo:project/path#Lx-Ly`. Do not add
`okf_version`, `generated`, `verified`, `human`, or `stale_after`; indexes and
trust metadata are deterministic publisher output.

### Source citation format (golden triple)

Every load-bearing claim needs all three of: frontmatter `sources` entry,
in-body `[^id]` reference, and a matching footnote definition.

```markdown
---
type: Module
title: Example module
description: Short description of the page.
sources:
  - id: api-index
    resource: repo:api/src/index.ts#L1-L2
---

The module exports the answer.[^api-index]

[^api-index]: [Source](repo:api/src/index.ts#L1-L2)
```

Anti-patterns (will fail validation):

- **No definition** — body has `[^api-index]` but no `[^api-index]: ...` footnote.
- **Frontmatter not cited** — `sources` lists `api-index` but the body never uses `[^api-index]`.
- **Direct repo in body** — prose links `[file](repo:api/src/index.ts#L1-L2)` instead of a source footnote.
- **Resource mismatch** — footnote `repo:` path/range differs from the frontmatter `resource` for that `id`.
- **Orphan / undeclared id** — footnote or `[^id]` uses an id missing from frontmatter `sources`.

Use the page contract, selected research catalog findings, shared terms, relevant
cross-link contracts, authorized source roots, and exact Wiki read paths as the
working set. Answer every `readerQuestion` and substantively cover every
`requiredFacet`; these are acceptance criteria, not headings to copy blindly.
Explain responsibilities, mechanisms, and boundaries instead of restating files.

For Chinese output, preserve source-authored Chinese domain and concept names
from code or comments in frontmatter, headings, diagrams, and prose. Do not
silently replace them with your own translations; translate only when no
corresponding Chinese name is established in the authorized evidence.

Every `outgoingCrossLinks` contract is mandatory: this page must contain an
actual Markdown link using its engine-derived relative `href`, which resolves
to the Wiki-root-relative `toPath`. Do not use `toPath` itself as the href.
`incomingCrossLinks` are context for navigation and do not require adding a
reverse link unless it helps the reader.

Use research catalog findings as locators, not proof. Re-open every load-bearing
source span with `read`, `grep`, `find`, or `ls` before citing it. Do not seek
unrelated roots or reconstruct omitted synthesis/review context.

Decide whether Mermaid materially clarifies verified source. Use only
`flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, or
`erDiagram`. For flowcharts use an explicit `TD`, `TB`, `BT`, `RL`, or `LR`
direction. Use ASCII identifiers, quote human-readable labels, keep one
relationship per line, and avoid HTML and experimental syntax. Never use
init/config directives, `click`, event handlers, or dangerous URL schemes.
Place explanatory prose and citations nearby, and omit a diagram when prose is
clearer. Never add speculative structure.

After writing, call `wiki_submit_page` for the assigned page. It returns all
currently detectable page defects together. Fix the complete result in the
same writer session and submit again until accepted. Do not finish after merely
writing the file. Treat `validator-infrastructure` as a workflow failure; never
rewrite valid content to guess around a validator failure.

An Overview writer runs after all target content pages in the current round.
It reads every target content page and all declared source roots, then writes
only `overview/overview.md`. A repair writer receives the current page,
authorized source, and the complete actionable defect set for that page. Fix
all supplied defects and pass `wiki_submit_page` in the same session. After any
content repair, the workflow regenerates Overview.

Use the supplied skeleton as optional ordering guidance. Omit unsupported
sections. Never delete pages or write `index.md`; the deterministic coordinator
and publisher derive the indexed final tree from the Spec.
