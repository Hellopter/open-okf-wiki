# Writing

Edit only the Candidate paths in `.okf-wiki/task/brief.md`. Complete the
assigned source-aware cluster; do not create speculative pages or thin stubs
merely to fill a topology. Root pages are cross-source synthesis.
Source/domain/concept pages retain source-local detail and minority evidence.

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

After every assigned Candidate page is updated, write `.okf-wiki/task/handoff.md`
starting with `# Write Handoff` and a short note of what changed. Keep evidence
on the Candidate pages. Then call `wiki_write_finish` with no arguments. If
the host rejects the file, fix the heading and finish again.

The host owns indexes and publication. It validates and atomically promotes
the candidate after the Lead finishes.
