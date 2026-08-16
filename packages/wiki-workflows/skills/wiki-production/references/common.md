# Common Rules

Declared source roots are the only source of truth. Use the scope paths from
the task; do not read the workspace root unless it is the declared Source.
Read only authorized source paths and write only authorized candidate paths.
Never write the published `wiki/`, `.okf-wiki` control files, source trees, or
files reached through a symlink escape.

Research evidence uses `path#Lx-Ly`. Published page sources use
`repo:<source>/<path>#Lx-Ly`. Every load-bearing claim needs a frontmatter
source entry, an in-body `[^id]` reference, and a matching footnote definition.

Every page needs non-empty `type`, `title`, `description`, and `sources`
frontmatter. Do not add publisher-owned trust fields or write `index.md`; the
deterministic finalizer owns indexes and publication metadata.

WikiSpec page fields are not written-page frontmatter. A Spec page uses
`pageType`, `path`, `title`, `purpose`, `readerQuestions`, `requiredFacets`,
and `findingIds` — never `description` or `sources`. Written YAML frontmatter
uses `type`, `title`, `description`, and `sources`; do not copy Spec `purpose`
or `pageType` into that frontmatter.

Keep large prose in the assigned Markdown artifact or candidate page. Return
only a concise summary, coverage, gaps, and artifact references through the
task receipt.
