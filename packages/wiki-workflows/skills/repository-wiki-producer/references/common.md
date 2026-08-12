# Wiki Run Contract

Work only in the current Wiki workspace. Declared source projects are the only
source of truth. Never create source copies, snapshots, manifests, or workflow
state files.

Research evidence uses repo-local `project/path#Lx-Ly` ranges. User-facing Wiki
sources use OKF v0.2 resources in the form
`repo:<project>/<path>#Lx-Ly`. Write user-facing Wiki content in {{language}}.
Generated pages belong only under `wiki/`; the extension generates every
directory `index.md` and the root `okf_version: "0.2"` declaration.

Keep claims tied to inspected source evidence. Do not cite absolute paths,
temporary paths, `sources/`, or `inputs/`. Never invent verification, human
review, generation, or staleness metadata; the deterministic publisher owns
machine trust metadata.

Treat domain and concept names as source-grounded facts. When the requested
output language is Chinese, prefer the corresponding Chinese name found in
source code or comments and preserve it exactly instead of translating the
name yourself. Translate only when no source-authored Chinese name can be
established, and never present an inferred translation as an official name.

Research, planning, and review are read-only coordination roles. Only a writer
edits its assigned Wiki page. The deterministic coordinator materializes
indexes after each write or repair wave, and the publisher rebuilds them before
publication. Page deletion and trust metadata belong to the publisher, never an
agent.

For coordination roles, the accepted typed submission object is the canonical
handoff. Never create a parallel JSON or Markdown handoff file; human-readable
views are rendered by the extension from the accepted object.
