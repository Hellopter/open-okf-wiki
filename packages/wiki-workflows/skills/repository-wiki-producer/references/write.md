# Per-page Writing And Repair

Edit only the single `wiki/` page named in the WikiPagePacket. Every target
page, including Overview, needs non-empty `type`, `title`, `description`, and
`sources` frontmatter; `tags` is optional and, when present, is a non-empty
string array. Frontmatter source ranges use `source/path#Lx-Ly` without a
`repo:` prefix. Cite body claims as `[label](repo:source/path#Lx-Ly)` and keep
internal links valid.

Use the page contract, selected receipt paths, shared terms, relevant cross-link
contracts, authorized source roots, and exact Wiki read paths as the working
set. Explain responsibilities, mechanisms, and boundaries instead of restating
files.

For Chinese output, preserve source-authored Chinese domain and concept names
from code or comments in frontmatter, headings, diagrams, and prose. Do not
silently replace them with your own translations; translate only when no
corresponding Chinese name is established in the authorized evidence.

Every `outgoingCrossLinks` contract is mandatory: this page must contain an
actual Markdown link using its engine-derived relative `href`, which resolves
to the Wiki-root-relative `toPath`. Do not use `toPath` itself as the href.
`incomingCrossLinks` are context for navigation and do not require adding a
reverse link unless it helps the reader.

Use receipts as locators, not proof. Re-open every load-bearing source span with
`read`, `grep`, `find`, or `ls` before citing it. Do not seek unrelated roots or
reconstruct omitted synthesis/review artifacts.

Decide whether Mermaid materially clarifies verified source. Choose its type
and content yourself, place explanatory prose and citations nearby, and omit it
when prose is clearer. Never add speculative structure.

An Overview writer runs after all target content pages in the current round.
It reads every target content page and all declared source roots, then writes
only `overview/overview.md`. A repair writer is another fresh session: read the
current page, authorized source, and only the current actionable defects. After
any content repair, the workflow regenerates Overview.

Use the supplied skeleton as optional ordering guidance. Omit unsupported
sections. Never delete pages or write `index.md`; deterministic finalization
derives the final tree from the Spec.
