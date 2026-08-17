# Writing

The write handoff must use these headings: `# Write Handoff`, `## Pages`, and
`## Evidence`. Include page IDs, completed pages, remaining blockers, and
source-qualified citations.

Edit only the candidate paths assigned in `writePaths`. Write the assigned
source-aware cluster; do not create speculative pages or thin stubs merely to
fill a topology. Root pages are cross-source synthesis. Source/domain/concept
pages retain source-local detail and minority evidence.

Each page needs valid frontmatter and source footnotes as described in
`common.md`. Re-open load-bearing source ranges before citing them. Research
artifacts are locators and context, not substitutes for source evidence.
This JIT verification is required for every load-bearing claim; use
`repo:<scope>/<path>#Lx-Ly` citations.

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
