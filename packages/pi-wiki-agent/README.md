# Pi Wiki Agent

`@okf-wiki/pi-wiki-agent` generates a source-grounded repository Wiki as an
[OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
Markdown bundle. It is a repository documentation tool, not a personal-memory
or chat-history Wiki.

## Install

```bash
pnpm -C packages/pi-wiki-agent build
pi install ./packages/pi-wiki-agent --local --approve
```

Rebuild and run `/reload` after local changes. Project-local extensions require
Pi project trust.

## Workflow

```text
/wiki init [--name name] [--lang en|zh]
/wiki source add path <path> [--id id]
/wiki generate [focus]
/wiki approve                # only when workflow.approval is propose
/wiki resume [run-id]
/wiki status [--json]
```

`workspace.yaml` uses version 5 and chooses one approval policy:

```yaml
workflow:
  approval: propose # propose | auto
```

`generate` freezes sources and starts one persisted main Pi session. It creates
an inventory, optionally asks read-only discovery agents for independent domain
briefs, writes `analysis/plan.md`, and obtains one independent coverage review.

With `propose`, the run pauses at that reviewed plan. Open `/wiki` to inspect
the plan and approve it in the Navigator; `/wiki approve` is the equivalent
command shortcut for the active run. Approval checks the frozen input and plan
digest, then resumes the exact same agent session to write, review, validate,
and seal the Wiki. With `auto`, it continues without a human pause. `/wiki
resume` recovers a paused, interrupted, or once quality-blocked run; a run lock
prevents concurrent resume of the same session.

## Artifacts

```text
.wiki-agent/runs/<run-id>/
  inputs/                 # frozen source inventory, snapshots, and sources/
  analysis/               # Markdown plan/reviews and persisted session
  bundle/                 # sealed final OKF v0.2 delivery
```

The model never writes host control state. It may write Markdown plans,
discovery/review reports, and bundle pages only. `bundle/index.md` and nested
directory indexes are generated deterministically. Concept pages carry OKF
frontmatter with source provenance and machine-generated metadata.

## Development

```bash
pnpm -C packages/pi-wiki-agent typecheck
pnpm -C packages/pi-wiki-agent test
pnpm --filter @okf-wiki/wiki-agent-kit test
```
