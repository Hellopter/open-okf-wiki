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

Initialization creates `workspace.yaml` v2, `.wiki-agent/runtime.json`, source registration, and one
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
ow prepare --mode auto|plan|write|retry-plan|retry-write [--focus TEXT]
ow handoff write|validate|publish --phase PHASE --producer ID --out analysis/handoffs/NAME.json \
  [--digest D]... [--artifact id:type:owner:path[:deps]]... [--artifacts-json REL] [--summary S]
ow checkpoint --phase PHASE --proposal analysis/handoffs/NAME.json
ow gate plan|check
ow validate
ow gc [--keep-runs N] [--dry-run] [--runs-only|--objects-only]
```

Handoff proposals are **host-authored** (`ow handoff write|publish` always sets `version: 2`). Agents
write data-plane artifacts and `*-artifacts.json` lists only — they must not invent proposal
`version` or `phase`. `ow handoff publish` writes the proposal then checkpoints. `ow checkpoint` alone
remains valid when a proposal file already exists. `ow validate` prepares a verified candidate
manifest; its following `validate` checkpoint is the only transition to `sealed`.

## Freeze storage

`ow prepare` freezes each registered source into the run workdir as filtered evidence under
`workdir/sources/<id>/`. File bytes are stored **write-once** in the workspace CAS:

```text
.wiki-agent/objects/sha256/<aa>/<sha256>
```

Each run path tree hardlinks into those objects when the filesystem allows (NTFS/local same volume,
no admin required for file hardlinks). Cross-volume or permission failures fall back to a full copy.
The method pack remains a small recursive copy. Placement counters (`hardlinked`, `copied`,
`objectsCreated`, `objectsReused`) are recorded on the freeze snapshot and run meta.

Use `ow gc` to drop old non-active runs (default: keep the newest 3, always protect
`.wiki-agent/current.json`) and reclaim unreferenced CAS objects. Prefer `--dry-run` first.

## Handoff and ownership

- `analysis/checkpoints/*.json` is the durable control plane.
- `analysis/handoffs/*.json` are host-authored control-plane proposals; receipts, pages, and defects are the data plane.
- `analysis/page-assignments.json` assigns every page to exactly one source/domain or integration
  owner. Shards cannot write another owner's path.
- Fan-out concurrency comes from `inputs/run-policy.json` `limits`: `batchConcurrency` default 4
  (3 multi-source), `perSourceConcurrency` 2, `maxCoveragePasses` 2, `maxRepairRounds` 2. Waves are
  fair-packed by source under the global and per-source caps.
- Survey pass 1 covers every inventory coverage unit (sources and surfaces). Later passes retry
  `missingUnitIds` and transient rate-limit failures. Repair stops when the major/blocking defect
  fingerprint fails to improve.

## Failure and recovery

| Condition | Result |
|---|---|
| Invalid handoff, stale digest, missing dependency, duplicate owner | Checkpoint rejects the transition. |
| Required shard fails | Run is checkpointed as blocked; no integration or validation proceeds. |
| Plan gate fails | Fix the planned artifacts and rerun `/wiki --retry plan`. |
| Candidate review or validation fails | Run `/wiki --retry write`; source and plan checkpoints remain intact. |
| Validate command completed but the terminal checkpoint did not | Run `/wiki`; it resumes at Validate without rewriting pages. |
| Sealed or tampered candidate | `ow prepare` fails closed until a retry starts a replacement write. |

## Compatibility

vNext supports only `workspace.yaml` v2 and the single `/wiki` workflow. It intentionally does not
read legacy workspace formats, Skills, workflow names, CLI commands, or run pointers.
