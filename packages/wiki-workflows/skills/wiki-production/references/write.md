# Writing

Edit only the candidate paths assigned in `writePaths`. Related pages may be
written together; do not create speculative pages or thin stubs merely to fill
a topology.

Each page needs valid frontmatter and source footnotes as described in
`common.md`. Re-open load-bearing source ranges before citing them. Research
artifacts are locators and context, not substitutes for source evidence.

Before writing a page, read `templates/<pageType>.md` for that page's
`pageType` (`overview`, `architecture`, `domain`, `concept`, `flow`, `state`,
`data`, `module`). Use the skeleton only when verified source supports a
section; do not invent headings to fill it.

Use Mermaid only when it materially clarifies verified behavior. Allowed forms
are `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, and
`erDiagram`; avoid configuration directives, clicks, HTML, and speculative
relationships.

Do not write indexes, publisher metadata, or the published Wiki. The host
validates and atomically promotes the candidate after the Lead finishes.
