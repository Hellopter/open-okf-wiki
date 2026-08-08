# @okf-wiki/wiki-agent-kit

Framework-neutral deterministic core for source-grounded repository Wikis.
The Pi extension owns user interaction and model execution; this package owns
workspace state, frozen source snapshots, OKF bundle validation, and sealing.

## Design

Each run produces one self-contained `bundle/` in Google Open Knowledge Format
(OKF) v0.2. The bundle is plain Markdown with YAML frontmatter, so it is both
human-readable and usable as an agent handoff. The host keeps only small JSON
control state for run identity, frozen input digests, approval, main-session
location, orchestration locking, and bundle sealing. Model analysis is Markdown
under `analysis/`.

The core retains a deterministic source inventory. Every required inventory unit
must appear in a host-validated page matrix with a frozen-source-citing evidence
brief and a diagram decision. It uses no model-authored receipts, page ownership
maps, or staged JSON gates. Before sealing, the host requires the bounded
coverage review, four passing final quality reports, and conservative local
Mermaid fence validation; it does not launch a browser renderer.

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

The exported ESM API is `createWikiCore()`. Its async `WikiCore` owns workspace
management, run lifecycle, and run access. `WikiRunPaths`, `WikiRunState`, and
the narrow `WikiWorkspaceCore`, `WikiRunLifecycleCore`, and `WikiRunAccessCore`
ports are exported TypeScript contracts. The Pi extension is the public
interactive surface; this package does not install a command-line workflow or
expose low-level path/pointer mutation helpers.

Workspace configuration is version 5 and contains `workflow.approval: propose |
auto`. A run uses the sole terminal status `complete`, stores the persistent
agent file as `mainSessionPath`, and returns `resumeAt: discover | plan | write`.
Older workspace formats are intentionally unsupported.
