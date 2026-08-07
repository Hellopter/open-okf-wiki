# @okf-wiki/wiki-agent-kit

Framework-neutral deterministic core for source-grounded repository Wikis.
The Pi extension owns user interaction and model execution; this package owns
workspace state, frozen source snapshots, OKF bundle validation, and sealing.

## Design

Each run produces one self-contained `bundle/` in Google Open Knowledge Format
(OKF) v0.2. The bundle is plain Markdown with YAML frontmatter, so it is both
human-readable and usable as an agent handoff. The host keeps only small JSON
control state for run identity, frozen input digests, approval, session location,
locking, and bundle sealing. Model analysis is Markdown under `analysis/`.

The core retains a deterministic source inventory. Every required inventory unit
must either be represented in the Wiki plan and bundle or explicitly excluded in
that plan. It uses no model-authored receipts, page ownership maps, or staged
JSON gates.

## Run Layout

```text
.wiki-agent/runs/<run-id>/
  inputs/                 # manifest, inventory, and immutable source copies
    sources/
  method/                 # frozen agent method guidance
  analysis/               # plan, discovery/review Markdown, session and state
  bundle/                 # sealed OKF v0.2 Wiki delivery
```

`bundle/index.md` declares `okf_version: "0.2"`. Directory indexes are generated
deterministically. Concept pages use the minimal traceability set: `type`,
`title`, `sources`, `generated`, and `status`.

## Host API

The exported ESM API initializes workspaces and sources, prepares frozen runs,
reads run paths/state, claims a run before session execution, approves a
proposed plan, validates an OKF bundle, and seals a valid bundle. The Pi adapter
is the public interactive surface; this package does not install a command-line
workflow.

Workspace configuration is v4 and contains `workflow.approval: propose | auto`.
Older workspace formats are intentionally unsupported.
