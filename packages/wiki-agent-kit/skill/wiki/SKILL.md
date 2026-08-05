---
name: wiki
description: Produce a source-grounded OKF wiki for this workspace. Human entrypoint — invoke as /wiki [optional focus]. Prepares a frozen run via host CLI then starts the matching Claude workflow.
disable-model-invocation: true
allowed-tools: Bash(node *) Bash(ow *) Read
---

# /wiki — human entry

You are the **only human-facing entry** for wiki generation. The `ow` CLI is an **agent API**, not a human checklist. Do not ask the user to run `ow run` / `ow gate` / `ow validate` in the default path.

## 1. Prepare (deterministic)

Run the kit entry helper with Node (absolute path via this skill directory). Pass focus from `$ARGUMENTS` when present.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/entry.mjs --focus "$ARGUMENTS"
```

If `$ARGUMENTS` is empty:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/entry.mjs
```

If the workspace is not cwd:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/entry.mjs --workspace /abs/workspace --focus "$ARGUMENTS"
```

Optional human plan approval mode:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/entry.mjs --focus "$ARGUMENTS" --approve-plan
```

Parse the JSON stdout. On `ok: false`, stop and show `error` / `hint`.

## 2. Route (Claude workflow)

| Helper `action` | Do this |
|---|---|
| `freeze` or `resume` | Invoke the workflow named in `workflowCommand` **with no JSON args** (e.g. `/wiki-produce`). Pointers live in `.wiki-agent/current.json`. |
| `done` | Report sealed status; offer retry / new focus. Do not re-write sealed candidate. |

Workflows (advanced; humans normally only type `/wiki`):

- `/wiki-produce` — default E2E: plan → auto gate → write → review → validate
- `/wiki-plan` — plan only (+ auto gate unless approvePlan)
- `/wiki-write-review` — write/review/validate when write-ready

## 3. Rules

1. Prefer the helper over inventing freeze logic.
2. Never paste `runId`/`workdir` unless the user is debugging.
3. Host gates and validate run **inside** workflows via pinned `hostCli`.
4. Method instructions live in the frozen run at `workdir/skill/` (hidden method skill `repository-wiki-producer`); do not send users to `/repository-wiki-producer`.
5. Dynamic Workflows must be enabled (`/config`). If workflows are unavailable, stop with that prerequisite.

## 4. After success

Tell the user the candidate is under `.wiki-agent/runs/<runId>/workdir/candidate/` and that it is sealed when validate succeeds. Recovery: host `ow retry --from plan|write` then `/wiki` again.
