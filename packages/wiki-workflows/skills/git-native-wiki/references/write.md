# Writing And Repair

Only edit `wiki/`. Every concept page needs YAML frontmatter with non-empty
`type`, `title`, `description`, and a non-empty `sources` list using
workspace-relative `path#Lx-Ly` ranges. Cite body claims as
`[label](repo:path#Lx-Ly)` and keep internal links valid.

Write or repair the actual pages, then end with a brief Markdown summary if it
is useful. Do not return a JSON manifest: validation derives the page set from
the filesystem.
