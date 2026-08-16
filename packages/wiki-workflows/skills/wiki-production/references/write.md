# Writing

Edit only the candidate paths assigned in `writePaths`. Write the assigned
cluster; do not create speculative pages or thin stubs merely to fill a
topology.

Each page needs valid frontmatter and source footnotes as described in
`common.md`. Re-open load-bearing source ranges before citing them. Research
artifacts are locators and context, not substitutes for source evidence.

Before writing a page, read `templates/<pageType>.md` for that page only
(`overview`, `architecture`, `domain`, `concept`, `models`, `flow`,
`sequences`, `state`, `data`, `module`). Use the skeleton only when verified
source supports a section.

Use Mermaid only when it materially clarifies verified behavior. Allowed forms
are `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, and
`erDiagram`; avoid configuration directives, clicks, HTML, and speculative
relationships. Put `sequenceDiagram` blocks on the cluster `flows.md` unless
they overflow to `sequences.md`.

The host owns indexes and publication. It validates and atomically promotes
the candidate after the Lead finishes.
