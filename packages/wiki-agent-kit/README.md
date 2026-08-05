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

From the repository root, register this development package as the global `ow` command.

### macOS and Linux

```bash
pnpm --dir packages/wiki-agent-kit link --global
command -v ow
ow help
```

If `ow` is not found, run `pnpm setup`, start a new shell, and rerun the link command. The new
shell must include pnpm's global bin directory in `PATH`.

### Windows PowerShell

```powershell
pnpm --dir packages/wiki-agent-kit link --global
Get-Command ow
ow help
```

If PowerShell cannot find `ow`, run `pnpm setup`, close all PowerShell windows, open a new one,
and rerun the link command. This configures pnpm's user-level global bin directory in `PATH`; it
does not require an administrator shell.

## Create a Workspace

```bash
ow init ./my-wiki --name my-wiki --lang zh
cd my-wiki
ow source add clone https://github.com/example/app.git --id app
# or: ow source add path /absolute/path/to/repo --id app

ow doctor
```

`ow init` writes `workspace.yaml` by default (YAML is easier to edit by hand). Legacy
`workspace.json` and `workspace.yml` still load. Keep **exactly one** of those files in a workspace.
Use `--format json` only when you intentionally want JSON:

```bash
ow init ./my-wiki --name my-wiki --lang en --format json
```

Example `workspace.yaml`:

```yaml
version: 1
id: 2c29d313-5252-4321-97b9-1ae1ea9a9c74
name: my-wiki
wikiLanguage: zh
defaultSourceIgnores:
  enabled: true
sources:
  - id: app
    path: sources/app
    applyDefaultIgnores: true
    ignore: []
    presets: []
    origin:
      type: path
      linkedPath: /absolute/path/to/repo
```

### Local path sources on Windows

`ow source add path` registers a local directory under `sources/<id>` without copying it:

| Platform | Link type | Admin / Developer Mode |
|----------|-----------|------------------------|
| Windows (local drive path) | Directory **junction** | Not required |
| Windows (UNC / network path) | Directory **symlink** | Developer Mode or elevated shell |
| macOS / Linux | Directory **symlink** | Not required |

Prefer a normal local path such as `C:\work\app`. Junctions cannot target network shares; for those,
either enable [Developer Mode](https://learn.microsoft.com/windows/apps/get-started/enable-your-device-for-development)
and retry `source add path`, or avoid the link entirely:

```powershell
ow source add clone C:\work\app --id app
# or a remote:
ow source add clone https://github.com/example/app.git --id app
```

Global `pnpm link` and local path junctions are both user-level operations; neither needs an
administrator shell for ordinary local work.

`ow init` installs the Skill for generic agents and Claude, plus Claude project workflows:

```text
.agents/skills/repository-wiki-producer/
.claude/skills/repository-wiki-producer/
.claude/workflows/wiki-produce.workflow.js
.claude/workflows/wiki-plan.workflow.js
.claude/workflows/wiki-write-review.workflow.js
```

Use `ow install --force` after intentionally updating the kit. A freeze refuses drifted installed
assets, so every run records the exact Skill that it copied. Start a new Claude Code session after
installing workflows so project assets are rediscovered.

## Default Claude Flow (automatic)

No JSON args. No hand-run gates. Host CLI actions run inside workflows.

```bash
# 1. From the wiki workspace, freeze + set active-run pointers.
ow run --focus "authentication and request flow"

# 2. In a new Claude Code session started in this workspace:
claude
# Confirm Dynamic Workflows in /config, then:
/wiki-produce
```

What happens automatically:

1. `/wiki-produce` resolves `.wiki-agent/current.json` (no args required)
2. Discover + Plan write Discovery Map and Spec
3. Workflow runs `ow gate plan` through pinned `hostCli`
4. Write + independent review + one repair round
5. Workflow runs `ow gate check` and `ow validate`, then seals

`ow run` / `ow freeze` write:

```text
.wiki-agent/current.json
.wiki-agent/next-action.json
```

Workflows resolve identity in this order: explicit args → `current.json` → `next-action.json` →
newest valid run. Explicit `{runId,workdir}` args remain supported for CI/debug only.

### Optional human plan approval

```bash
ow run --focus "..." --approve-plan
# Claude:
/wiki-plan
# Terminal after reviewing Spec:
ow approve plan
# Claude:
/wiki-write-review
```

### Split workflows

| Command | Behavior |
|---|---|
| `/wiki-produce` | End-to-end (default) |
| `/wiki-plan` | Plan + auto gate (or stop when `approvePlan`) |
| `/wiki-write-review` | Write/review/validate when write-ready |

### Recovery

```bash
ow status
ow retry --from plan    # or --from write
ow run --resume
# then re-run the workflow named in next-action (usually /wiki-produce or /wiki-write-review)
```

Low-level host commands remain available for debugging:

```text
ow freeze [--focus TEXT] [--approve-plan]
ow gate plan|check [--run <runId>]
ow validate [--run <runId>]
ow approve plan [--run <runId>]
ow retry [--run <runId>] --from plan|write
```

When `--run` is omitted, these commands use the active pointer from `.wiki-agent/current.json`.

## Failure Handling

| Condition | Required action |
|---|---|
| `ow doctor` reports asset drift | Run `ow install --force`, then start a new Claude Code session. |
| `ow doctor` reports an unsupported or missing Claude CLI | Install or upgrade Claude Code before attempting the workflow. |
| Dynamic Workflows is absent or disabled in `/config` | Enable the supported feature for the account/session. This kit has no alternate execution path. |
| Plan gate fails inside `/wiki-plan` or `/wiki-produce` | Fix Discovery Map/Spec and retry; or `ow retry --from plan` then rerun the workflow. |
| Write/review does not validate | `ow retry --from write`, then `/wiki-write-review` or `/wiki-produce`. |
| A candidate is `sealed` or `tampered` | Do not edit or reseal it. Use `ow retry --from write` to create a replacement candidate. |

## Run Layout

```text
.wiki-agent/
  current.json                      # active run pointer (no-arg workflows)
  next-action.json                  # next command + reason
  runs/<runId>/
    meta.json                       # freeze identity and immutable input summary
    workdir/
      sources/<sourceId>/           # filtered, content-hashed source snapshot
      skill/                        # exact copied Skill
      inputs/                       # inventory, policy, manifests, gate receipt
      analysis/                     # map, Spec, receipts, defects, validation, manifest
      candidate/                    # generated Wiki pages; never published by this kit
```

`ow status` derives each run state from artifacts rather than mutating lifecycle fields in
`meta.json`: `frozen`, `planned`, `write-ready`, `sealed`, or `tampered`. A successful validation
writes `analysis/candidate.manifest.json`; its candidate is immutable. To make a replacement,
explicitly run `ow retry --from write`. `ow retry --from plan` also clears the plan and gate before
the next plan workflow. Frozen sources and the copied Skill are never changed.

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
ow gate check
ow install --force
ow help
```

### Language and multi-source depth

- `wikiLanguage` (`en`|`zh`) is frozen into `inputs/run-policy.json` and `inputs/inventory.json`.
  Claude workflows inject it into survey/plan/write/review prompts. For `zh`, candidate prose
  must be Simplified Chinese; identifiers and paths stay untranslated.
- Multi-source workspaces (`sourceCount >= 2`, inventory tier `L3`) require deep analysis: the plan
  gate rejects thin Specs. Expect overview + per-source coverage + a critical cross-source flow (or
  an explicit `crossSourceFlowCancellation`), with at least `max(3, sourceCount + 1)` pages.
- After `ow install --force`, start a new Claude Code session so updated workflows and Skill text
  are rediscovered.
