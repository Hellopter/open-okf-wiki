# Common Rules

Declared source roots are the only source of truth. Read only authorized source
paths and write only authorized candidate paths. Never write the published
`wiki/`, `.okf-wiki` control files, source trees, or files reached through a
symlink escape.

Research evidence uses `path#Lx-Ly`. Published page sources use
`repo:<source>/<path>#Lx-Ly`. Every load-bearing claim needs a frontmatter
source entry, an in-body `[^id]` reference, and a matching footnote definition.

Every page needs non-empty `type`, `title`, `description`, and `sources`
frontmatter. Do not add publisher-owned trust fields or write `index.md`; the
deterministic finalizer owns indexes and publication metadata.

Keep large prose in the assigned Markdown artifact or candidate page. Return
only a concise summary, coverage, gaps, and artifact references through the
task receipt.
