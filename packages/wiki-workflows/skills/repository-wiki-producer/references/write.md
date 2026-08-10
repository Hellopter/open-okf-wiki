# Per-page Writing And Repair

Edit only the single `wiki/` page named in the WikiPagePacket. Every concept
page needs non-empty `type`, `title`, `description`, and `sources` frontmatter;
`tags` is optional. Cite claims as `[label](repo:path#Lx-Ly)` and keep internal
links valid.

Use the page contract, selected receipt paths, shared terms, relevant cross-link
contracts, authorized source roots, and exact Wiki read paths as the working
set. Explain responsibilities, mechanisms, and boundaries instead of restating
files.

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
