# @okf-wiki/wiki-agent-kit

Source-grounded, run-local OKF Wiki candidates from registered repositories.

## Architecture

| Layer | Role |
|---|---|
| `/wiki` Workflow | One native Claude Code Dynamic Workflow that owns orchestration. |
| `method/` pack | Progressive production guidance, frozen into each run but never installed as a Skill. |
| `ow` CLI | Deterministic workspace, checkpoint, gate, and validation authority. |

The workflow graph is `Bootstrap -> Discover -> Plan -> Write -> Verify/Repair -> Validate`.
Every edge is a host-validated checkpoint. Agents exchange compact envelopes and artifact paths; full
evidence stays in the run workdir.

## Requirements

- Node.js 22+
- Claude Code `2.1.154+` with Dynamic Workflows enabled in `/config`

## Setup

Global-link **this package** so the `ow` bin is registered. From the monorepo root:

```bash
pnpm --dir packages/wiki-agent-kit link --global
# or: cd packages/wiki-agent-kit && pnpm link --global
ow help
```

Do not `pnpm link --global` at the monorepo root: the root workspace package has no `bin` field, so
pnpm prints `has no binaries` and does not install `ow`. If that already happened, clean it up with
`pnpm remove -g open-okf-wiki-wiki-agent-kit` and re-link this package.

Then initialize a workspace:

```bash
ow init ./my-wiki --name my-wiki --lang zh --path /abs/repo --id app
cd my-wiki
ow doctor
claude
```

Initialization creates `workspace.yaml`, `.wiki-agent/runtime.json`, source registration, and one
workflow at `.claude/workflows/wiki.workflow.js`. Install always writes that workflow with LF line
endings; Windows CRLF checkouts are rewritten by `ow init` / `ow install` so Claude Code's Workflow
`script` approval path does not reject hidden `\r` control characters.

## Human workflow

```text
/wiki authentication and request flow   # complete run
/wiki --plan authentication flow         # freeze, discover, plan, and checkpoint only
/wiki --write                            # consume the current approved plan checkpoint
/wiki --retry write                      # discard write descendants and retry them
```

`/wiki --plan` is the explicit human approval boundary. A workflow cannot wait for user input while
running, so `/wiki --write` is the only edge from a plan checkpoint with a valid host gate receipt to writing.

## Host API

The workflow calls the CLI through the pinned `hostCli` recorded in `inputs/run-policy.json`.

```bash
ow prepare --mode auto|plan|write|retry-plan|retry-write|restart [--focus TEXT]
ow survey-merge --pass N [--labels REL]
ow publish --phase PHASE --artifacts-json REL
ow gate plan|check
ow validate
```

Agents write data-plane artifacts and compact `*-artifacts.json` lists. Discover is the exception:
workers write only content receipts, while `ow survey-merge` validates them, adds the host envelope,
mechanically writes the Discovery Map, and produces the only publishable Discover artifact list. `ow publish`
replays that merge list, validates paths, computes digests, derives the only valid predecessor, and writes a
v3 checkpoint. `ow validate` prepares a verified candidate manifest; its following `validate` publish is the
only transition to `sealed`.

## Frozen sources

`ow prepare` copies each registered source into the run workdir as filtered evidence under
`workdir/sources/<id>/`. The snapshot manifest records the content digest and complete file list
for every frozen source; later lifecycle stages verify that copy rather than reading the live source.

## Checkpoints and ownership

- `analysis/checkpoints/*.json` is the durable local control plane.
- Receipts, pages, and defects are data-plane files. Artifact lists contain only `id`, `type`, `path`,
  and discovery `coverageUnitIds` where applicable.
- `analysis/page-assignments.json` assigns every page to exactly one source/domain or integration
  owner. Shards cannot write another owner's path.
- Fan-out concurrency comes from `inputs/run-policy.json` `limits`: `batchConcurrency` default 4
  (3 multi-source), `perSourceConcurrency` 2, `maxCoveragePasses` 2, `maxRepairRounds` 2. Waves are
  fair-packed by source under the global and per-source caps.
- Survey pass 1 covers every inventory coverage unit (sources and surfaces). Later passes retry
  `missingUnitIds` and transient rate-limit failures. Repair stops when the major/blocking defect
  fingerprint fails to improve.
- A permanent failed or skipped survey receipt remains visible. Plan must cancel that coverage unit with a
  reason and may not bind it to a page or domain.

## Failure and recovery

| Condition | Result |
|---|---|
| Invalid artifact, stale digest, invalid predecessor, or incomplete discovery coverage | Publish rejects the transition. |
| Old or hand-built Discover merge list | Publish rejects it; rerun the host survey merge for the current receipts. |
| Required shard fails | Workflow stops; retry or restart is explicit. |
| Plan gate fails | Fix the planned artifacts and rerun `/wiki --retry plan`. |
| Candidate review or validation fails | Run `/wiki --retry write`; source and plan checkpoints remain intact. |
| Validate command completed but the terminal checkpoint did not | Run `/wiki`; it resumes at Validate without rewriting pages. |
| Sealed or tampered candidate | `ow prepare` fails closed; use `/wiki --restart` for a new frozen run. |

## Compatibility

V3 supports only its v3 checkpoints and the single `/wiki` workflow. It intentionally does not
read legacy workspace formats, Skills, workflow names, CLI commands, or run pointers.
