# @okf-wiki/wiki-agent-kit

`ow` freezes repositories into a source-grounded, run-local Wiki candidate. The kit installs the
same producer Skill for `.agents` and `.claude`; Claude Code additionally receives two Dynamic
Workflows for its interactive stages.

## Install and start

Node 22 or later is required.

```bash
node packages/wiki-agent-kit/scripts/ow.mjs init ./my-wiki --name my-wiki --lang en
cd my-wiki

# Register one or more repositories.
ow source add clone https://github.com/example/app.git --id app
# ow source add path /absolute/path/to/repo --id app

# Optional source-ignore controls, before the snapshot is made.
ow ignore presets
ow ignore set app --preset js-tests
```

`ow init` installs:

```text
.agents/skills/repository-wiki-producer/
.claude/skills/repository-wiki-producer/
.claude/workflows/wiki-plan.workflow.js
.claude/workflows/wiki-write-review.workflow.js
```

Hosts that discover `.agents/skills` or `.claude/skills` can use the same Skill and follow the
host commands below. Claude Code can also run the installed slash workflows. Reinstall intentional
changes with `ow install all --force`; a new freeze rejects drifted installed assets so the run is
always tied to the kit that created it.

## Two explicit stages

```bash
# 1. Freeze source snapshots and prepare a new candidate run.
ow produce

# 2. Enter the planning stage. It prints the exact Claude command and arguments.
ow plan --run <runId>
# In Claude Code: /wiki-plan with the printed { "runId", "workdir" } arguments

# 3. Bind the completed plan to the exact inventory, discovery map, and Spec.
ow gate plan --run <runId>

# 4. Enter write/review only after the gate succeeded.
ow write --run <runId>
# In Claude Code: /wiki-write-review with the printed arguments
```

The planning workflow performs Discover and Plan only. The host plan gate verifies coverage and
semantic sufficiency, then writes a digest-bound receipt. `ow write` and the write/review workflow
recheck that receipt before changing the candidate.

The write/review workflow writes the Spec-defined pages, runs independent review lenses, repairs
once when needed, and invokes `ow validate --run <runId>`. Validation regenerates indexes, checks
frontmatter and links, and seals the candidate on success.

## Run layout and immutability

```text
.wiki-agent/runs/<runId>/
  meta.json
  workdir/
    sources/<sourceId>/       # immutable filtered source snapshot
    skill/                    # skill copied into this run and content-hashed
    inputs/                   # inventory, snapshot manifest, run policy, plan-gate receipt
    analysis/                 # discovery map, Spec, review receipts, sealed-candidate manifest
    candidate/                # run-local Wiki candidate; no publish step exists
```

`candidate/` is deliberately run-local. A successful validation writes
`analysis/candidate.manifest.json`; subsequent `ow write` or `ow validate` calls refuse to alter it.
If the candidate or its manifest needs replacement, use the explicit reset:

```bash
ow retry --run <runId> --from discover|plan|write|review
```

The retry removes only derived artifacts for the selected phase and later work. It never changes
the frozen source snapshots.

## Source links

Every factual claim uses a normal local Markdown link from the candidate page to the frozen source
file with real one-based line fragments. For a root candidate page:

```md
[Source: src/A.java L10-L20](../sources/app/src/A.java#L10-L20)
```

For `candidate/modules/auth.md`, the equivalent source is:

```md
[Source: src/A.java L10-L20](../../sources/app/src/A.java#L10-L20)
```

This answers the navigation requirement: a renderer that opens local Markdown links can open the
actual frozen `src/A.java` file. `repo:`, remote URLs, `file://`, and editor-specific links are not
accepted. The `#L10-L20` fragment remains evidence metadata because not all local editors navigate
to Markdown line anchors.

## Contracts and checks

- Concept pages require YAML frontmatter with non-empty `type`, `title`, and `description`.
- `index.md` is host-generated; `log.md` is reserved. Neither belongs in the Spec page set.
- Required inventory coverage units must be bound by the Spec or cancelled with a non-empty reason.
- Multi-source runs require a cross-source flow, multi-unit domain, or an explicit cancellation.
- Candidate citations must resolve to a source file inside the frozen snapshot and have valid
  `#Lx-Ly` bounds.
- Snapshot, planning gate, and candidate manifests use deterministic SHA-256 tree/file digests.
- Reference schemas live in `schemas/` for discovery maps, Specs, defects, and candidate manifests.

Useful operations:

```bash
ow status
ow gate check --run <runId>
ow config set wikiLanguage zh
ow install all --force
ow help
```
