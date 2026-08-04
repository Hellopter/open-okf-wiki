# @okf-wiki/wiki-agent-kit

Portable **`ow` CLI** + **Producer Skill** + **Claude Dynamic Workflow** for source-grounded
OKF wikis. Host scripts own freeze / gate / validate; the skill owns method; the workflow owns
fan-out topology.

## Install / run `ow`

From the monorepo root:

```bash
# help
pnpm --filter @okf-wiki/wiki-agent-kit exec ow help

# or directly
node packages/wiki-agent-kit/scripts/ow.mjs help
```

The package bin is `ow` → `./scripts/ow.mjs` (Node ≥ 22).

## Quickstart

```bash
# 1. Workspace
ow init ./my-wiki --name my-wiki --lang en
cd my-wiki

# 2. Sources (clone or local path)
ow source add clone https://github.com/example/app.git --id app
# ow source add path /absolute/path/to/repo --id app

# 3. Optional ignores
ow ignore presets
ow ignore set app --preset js-tests
ow ignore show app

# 4. Freeze + prepare a run (installs skill + workflow into the workspace)
ow produce
# → prints runId, workdir; in Claude Code run workflow wiki-produce with those args

# 5. After the Plan phase of the workflow
ow gate plan --run <runId>
# fail-closed on unbound coverage / semantic insufficiency
# on success writes workdir/inputs/gate-plan.ok.json (Write phase requires this receipt)

# 6. After write/review
ow validate --run <runId>
# regenerates directory index.md + checks frontmatter and repo: citations
```

### Useful ops

```bash
ow status
ow config set wikiLanguage zh
ow retry --run <runId> --from plan
ow continue --run <runId>
ow install all --force   # re-copy skill + workflows from the kit
```

### Retry / continue (journal-backed resume)

Journal-backed **full resume is partial** today:

| Command | Behavior |
|---------|----------|
| `ow produce` / freeze | Creates an **empty** `journal.jsonl` for the run. |
| `ow retry --run <id> --from <phase>` | Clears journal entries for that phase and later phases; sets meta to retrying. Re-run the workflow from that phase. |
| `ow continue --run <id>` | Returns `skipCallIds` (journal `done` call ids) for the workflow to honor **when wired**. Until the workflow reads those ids, continue is advisory only. |

Do not assume `continue` alone restarts the Dynamic Workflow mid-pipeline without host/workflow support for `skipCallIds`.

## Layout (after `ow produce`)

```text
.wiki-agent/runs/<runId>/
  meta.json
  workdir/
    sources/<id>/     # frozen snapshots
    skill/            # repository-wiki-producer
    inputs/           # inventory, discovery-map shell, run-policy
    analysis/         # spec.json, receipts/, defects
    wiki/             # staging concept pages
.claude/workflows/wiki-produce.workflow.js
.agents/skills/repository-wiki-producer/
```

## Skill + workflow

| Artifact | Path |
|----------|------|
| Skill | `skill/repository-wiki-producer/` |
| Workflow | `workflows/wiki-produce.workflow.js` |

Method references: plan, generate, research, review, orchestrator-context.  
Workflow phases: Discover → Plan → Write → Review (file receipts + short envelopes).

**Always** run `ow gate plan` after Plan and before treating Write as authoritative.

## Contract highlights

- OKF v0.2 frontmatter: `type`, `title`, `description` — host owns `index.md` regeneration.
- Do not author `generated` / `verified` / `stale_after`.
- Citations: `repo:path#L1-L2` or `repo:id/path#L1-L2` (never invent lines; never `sources/` prefix).
- `wikiLanguage` `en` | `zh` for prose only; paths and citations stay untranslated.
- Coverage units from inventory/DiscoveryMap must be bound or cancelled — fail-closed.
