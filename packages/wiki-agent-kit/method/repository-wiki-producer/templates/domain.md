# Domain Template

Use for `domains/<domain>/overview.md`, the narrative entrance to one conceptual area.

- State the problem the domain solves and its boundary.
- Introduce the core concepts, responsibilities, and important interfaces.
- Explain where it participates in cross-domain workflows.
- Link to child concepts rather than reproducing their detail.
- Cite the source evidence for implementation-specific claims.

Use `type: domain`, a reader-oriented `title`, and non-empty `sources` frontmatter. Each source needs a
stable `id` and an `inputs/sources/...#Lx-Ly` resource. A domain is not a directory inventory or a generic
technical layer.
