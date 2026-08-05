# @okf-wiki/wiki-agent-kit

Source-grounded, run-local OKF Wiki candidates from registered repositories.

**Layering (2026 agent practice):**

| Layer | Audience | Role |
|---|---|---|
| **`/wiki` entry skill** | Humans | Only daily generate command |
| **Claude workflows** | Runtime | Multi-agent orchestration |
| **Method skill** (`repository-wiki-producer`) | Agents | Hidden progressive instructions; frozen into each run |
| **`ow` CLI** | Agents / CI / recovery | Deterministic host API (not a human checklist) |

## Requirements

- Node.js 22+
- Claude Code `2.1.154+` with **Dynamic Workflows** enabled (`/config`)

## One-time setup

```bash
pnpm --dir packages/wiki-agent-kit link --global   # from monorepo root
ow init ./my-wiki --name my-wiki --lang zh --path /abs/repo --id app
cd my-wiki
ow doctor
```

`ow init` installs:

```text
.claude/skills/wiki/                         # human entry /wiki
.claude/skills/repository-wiki-producer/     # method (user-invocable: false)
.agents/skills/repository-wiki-producer/
.claude/workflows/wiki-produce.workflow.js
.claude/workflows/wiki-plan.workflow.js
.claude/workflows/wiki-write-review.workflow.js
```

After kit updates: `ow install --force`, then **start a new Claude session**.

## Human path (default)

```bash
cd my-wiki
claude
# Dynamic Workflows on in /config, then:
/wiki authentication and request flow
```

`/wiki` will:

1. Run the deterministic entry helper (`skill/wiki/scripts/entry.mjs`) → `ow run` / resume pointers
2. Route to `/wiki-produce` (or plan/write-review as needed)
3. Workflows auto-run host `gate plan` / `gate check` / `validate` via pinned `hostCli`

No JSON args. No hand-run gates in the default path.

### Optional plan approval

```text
/wiki --approve-plan focus text
# or host: ow run --focus "..." --approve-plan
# after Spec:
ow approve plan
/wiki
```

## Agent / host API (`ow`)

Agents and workflows call these (JSON stdout). Humans use them for setup/recovery only.

```text
ow run | freeze | gate plan|check | validate | approve plan | retry | status | doctor | install
ow init | source | ignore | config
```

Workflows **must** use `inputs/run-policy.json` → `hostCli.{node,script,workspaceRoot}`, not a bare global `ow` when available.

Active pointers:

```text
.wiki-agent/current.json
.wiki-agent/next-action.json
```

## Advanced workflows

| Slash | Role |
|---|---|
| `/wiki-produce` | Real multi-phase E2E (default route from `/wiki`) |
| `/wiki-plan` | Discover/Plan + auto gate |
| `/wiki-write-review` | Write/review/validate |

## Failure / recovery

| Condition | Action |
|---|---|
| Asset drift | `ow install --force` + new Claude session |
| Plan gate fails | Fix Spec or `ow retry --from plan` then `/wiki` |
| Write/validate fails | `ow retry --from write` then `/wiki` |
| Sealed/tampered | Never edit sealed tree; `ow retry --from write` |

## Language & multi-source

- `wikiLanguage` `en`|`zh` frozen into policy/inventory; workflows inject into prompts
- Multi-source (`sourceCount >= 2` / tier L3): deep Spec required (overview + per-source + cross-source flow or cancellation)

## Source citations

```md
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)
```

Local frozen paths only; genuine line numbers.

## Migration from older kit

```bash
cd my-wiki
ow install --force
ow doctor
# new Claude session
/wiki
```

Old manual `ow run` + `/wiki-produce` still works as advanced/agent path.
