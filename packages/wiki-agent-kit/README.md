# @okf-wiki/wiki-agent-kit

Framework-neutral, deterministic domain core for source-grounded repository
Wiki production. The Pi extension owns user interaction and agent execution;
this package owns workspace data, frozen sources, checkpoints, gates, and
candidate sealing.

## Runtime Boundary

`initializePiWorkspace()` creates `workspace.yaml`, binds the workspace to a
Pi extension runtime, and optionally adds a path or cloned source. It never
copies host workflow files into the workspace.

The Pi extension provides a runtime descriptor:

```js
{
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: "wiki", digest: "sha256:<digest>" }
}
```

The core persists this in `.wiki-agent/runtime.json` with the current core and
method digests. `prepareRun()` fails closed if that binding is stale. Frozen
run policy records only the Pi runtime identity; it contains no executable
CLI path or shell authority.

## Host API

The package exports direct ESM functions for Pi tools:

- `initializePiWorkspace`, `getWorkspaceStatus`
- `prepareRun`, `mergeRunSurveyReceipts`, `publishRunArtifacts`
- `checkRunPlanGate`, `approveRunPlanGate`, `validateRunCandidate`
- `installRuntime`, `ensureRuntime`, `assertRuntime`

Artifacts remain run-local. `publishRunArtifacts()` calculates digests and
records the only valid next checkpoint. `validateRunCandidate()` seals a valid
candidate but does not advance the run; the caller publishes the validation
report as the terminal `validate` checkpoint.

## Domain Guarantees

The graph is `Bootstrap -> Discover -> Plan -> Write -> Verify/Repair ->
Validate`. Every edge is checkpointed. Source files are copied into each run,
and later stages verify those frozen bytes rather than reading live sources.

Plan gates require coverage, survey outcomes, semantic sufficiency, and unique
page ownership. Candidate validation requires assigned pages, valid local
citations, clean review defects, and an intact frozen snapshot. The default
source ignore set excludes `.wiki-agent/`, `.pi/`, and `.claude/`, allowing a
Pi workspace to document its current directory without ingesting its own
runtime output.
