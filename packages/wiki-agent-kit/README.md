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

```bash
pnpm --dir packages/wiki-agent-kit link --global
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

```text
ow prepare --mode auto|plan|write|retry-plan|retry-write [--focus TEXT]
ow checkpoint --phase PHASE --proposal analysis/handoffs/NAME.json
ow gate plan|check
ow validate
```

`ow checkpoint` is the only state-transition authority. It validates proposal paths and ownership,
recomputes artifact digests, checks input checkpoint dependencies, then advances
`.wiki-agent/current.json` atomically. `ow validate` prepares a verified candidate manifest; its
following `validate` checkpoint is the only transition to `sealed`.

## Handoff and ownership

- `analysis/checkpoints/*.json` is the durable control plane.
- `analysis/handoffs/*.json`, receipts, pages, and defects are the data plane.
- `analysis/page-assignments.json` assigns every page to exactly one source/domain or integration
  owner. Shards cannot write another owner's path.
- Survey, writer, and evidence-review fan-out is bounded to eight agents per wave.
- Coverage has at most two passes. Repair has at most two rounds and stops when the major/blocking
  defect fingerprint fails to improve.

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
