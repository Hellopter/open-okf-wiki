# @okf-wiki/wiki-agent-kit

`ow` turns registered repositories into an immutable, source-grounded, run-local Wiki candidate.
The kit has three separate responsibilities: the CLI owns deterministic state and validation, the
Skill owns the research and writing method, and Claude Dynamic Workflows own Claude agent
orchestration.

## Requirements

- Node.js 22 or newer.
- Claude Code `2.1.154` or newer.
- Dynamic Workflows enabled for the Claude Code account and session. Start a fresh Claude Code
  session from the workspace directory and verify the feature in `/config`.

Dynamic Workflows are a hard requirement for the Claude workflow path. `ow doctor` verifies the
installed assets and Claude CLI version, but cannot verify account entitlement or `/config`. There
is deliberately no fallback workflow implementation for an account or endpoint that does not
support Dynamic Workflows.

## Global CLI Installation

From the repository root, register this development package as the global `ow` command:

```bash
pnpm --dir packages/wiki-agent-kit link --global
command -v ow
ow help
```

If `ow` is not found, run `pnpm setup`, start a new shell, and rerun the link command. The new
shell must include pnpm's global bin directory in `PATH`.

## Create a Workspace

```bash
ow init ./my-wiki --name my-wiki --lang en
cd my-wiki
ow source add clone https://github.com/example/app.git --id app
# or: ow source add path /absolute/path/to/repo --id app

ow doctor
```

`ow init` installs the same frozen-method Skill for generic agents and Claude, plus the Claude
project workflows:

```text
.agents/skills/repository-wiki-producer/
.claude/skills/repository-wiki-producer/
.claude/workflows/wiki-plan.workflow.js
.claude/workflows/wiki-write-review.workflow.js
```

Use `ow install --force` after intentionally updating the kit. A freeze refuses drifted installed
assets, so every run records the exact Skill that it copied. Start a new Claude Code session after
installing workflows so project assets are rediscovered.

## Manual Claude Flow

Run commands from the workspace directory. `ow freeze` returns the exact `runId` and absolute
`workdir` to pass to Claude.

```bash
# 1. Snapshot sources, inventory, policy, and the Skill.
ow freeze --focus "authentication and request flow"

# 2. In a new Claude Code session started in this workspace:
claude
# Confirm Dynamic Workflows in /config, then run the command emitted by freeze:
/wiki-plan {"runId":"<runId>","workdir":"<absolute-workdir>"}

# 3. Back in the terminal, check the completed plan and obtain the next workflow arguments.
ow gate plan --run <runId>

# 4. In Claude Code, run the command emitted by the successful gate:
/wiki-write-review {"runId":"<runId>","workdir":"<absolute-workdir>"}
```

`/wiki-plan` does discovery and planning only. It writes the Discovery Map and Spec, then stops.
`ow gate plan` checks coverage and semantic sufficiency and records the digests it approved.
`/wiki-write-review` rechecks that receipt, writes the Spec-defined pages, runs independent review
lenses, repairs unresolved issues once, and calls the pinned host CLI to validate and seal.

Do not use `ow plan`, `ow write`, or `ow continue`; those workflow-launching wrappers do not exist.
The only lifecycle commands are:

```text
ow freeze [--focus TEXT]
ow gate plan|check --run <runId>
ow validate --run <runId>
ow retry --run <runId> --from plan|write
```

`ow validate` remains available for a deterministic manual final check. It refuses to seal unless
the current plan-gate receipt matches the current inventory, Discovery Map, and Spec.

## Failure Handling

| Condition | Required action |
|---|---|
| `ow doctor` reports asset drift | Run `ow install --force`, then start a new Claude Code session. |
| `ow doctor` reports an unsupported or missing Claude CLI | Install or upgrade Claude Code before attempting the workflow. |
| Dynamic Workflows is absent or disabled in `/config` | Enable the supported feature for the account/session. This kit has no alternate execution path. |
| `ow gate plan` fails | Correct the Discovery Map or Spec in a new `/wiki-plan` attempt; use `ow retry --from plan` when discarding all plan artifacts. |
| Write/review does not validate | Use `ow retry --from write`, then rerun `/wiki-write-review` with the same frozen `runId` and `workdir`. |
| A candidate is `sealed` or `tampered` | Do not edit or reseal it. Use `ow retry --from write` to create a replacement candidate. |

## Run Layout

```text
.wiki-agent/runs/<runId>/
  meta.json                         # freeze identity and immutable input summary
  workdir/
    sources/<sourceId>/             # filtered, content-hashed source snapshot
    skill/                          # exact copied Skill
    inputs/                         # inventory, policy, manifests, gate receipt
    analysis/                       # map, Spec, receipts, defects, validation, manifest
    candidate/                      # generated Wiki pages; never published by this kit
```

`ow status` derives each run state from artifacts rather than mutating lifecycle fields in
`meta.json`: `frozen`, `planned`, `write-ready`, `sealed`, or `tampered`. A successful validation
writes `analysis/candidate.manifest.json`; its candidate is immutable. To make a replacement,
explicitly run `ow retry --from write`. `ow retry --from plan` also clears the plan and gate before
the next `/wiki-plan` run. Frozen sources and the copied Skill are never changed.

## Source Citations

Every factual claim must be a normal local Markdown link into the frozen snapshot with genuine
one-based source lines. This lets compatible Wiki renderers open the actual copied source file.

```md
<!-- candidate/overview.md -->
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)

<!-- candidate/modules/auth.md -->
[Source: src/A.java L10-L20](../../sources/app/src/A.java#L10-L20)
```

Links using `repo:`, remote URLs, `file://`, `vscode://`, paths outside `sources/`, or invalid line
ranges fail validation. `index.md` is generated by the validator; `log.md` is reserved.

## Other Operations

```bash
ow source list
ow ignore presets
ow ignore set app --preset js-tests
ow config set wikiLanguage zh
ow status
ow gate check --run <runId>
ow install --force
ow help
```
