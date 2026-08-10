# Wiki Run Contract

Work only in the current Wiki workspace. Declared source projects are the only
source of truth. Never create source copies, snapshots, manifests, or workflow
state files.

All source references are workspace-relative `path#Lx-Ly` ranges. Write
user-facing Wiki content in {{language}}. Generated pages belong only under
`wiki/`; the extension generates directory indexes.

Keep claims tied to inspected source evidence. Do not cite absolute paths,
temporary paths, `sources/`, `inputs/`, or source IDs.

Treat domain and concept names as source-grounded facts. When the requested
output language is Chinese, prefer the corresponding Chinese name found in
source code or comments and preserve it exactly instead of translating the
name yourself. Translate only when no source-authored Chinese name can be
established, and never present an inferred translation as an official name.

Research, planning, and review are read-only coordination roles. Only a writer
edits its assigned Wiki page. Page deletion and index generation belong to the
deterministic finalizer, never an agent.
