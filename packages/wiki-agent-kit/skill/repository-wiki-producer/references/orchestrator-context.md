# Orchestrator context

Keep the **main orchestrator** (workflow script + parent session) at **O(index)** size. Full evidence
lives on disk; children return envelopes only.

## Principle

The orchestrator must not “remember” child work product. It holds **goals, indexes, path lists,
budgets, and the next decision**. Intermediate results live in **script variables / disk**, never as
pasted transcripts.

## Handoff planes

| Plane | Content |
|-------|---------|
| **Control** | `{ status, path, summary }` — summary ≤ ~800 tokens / ~8 bullets |
| **Data** | Full receipt / Spec / pages / defects on disk under `analysis/` or `wiki/` |
| **Orchestrator** | `args` (`runId`, `workdir`), phase name, unit id ledger, path lists |

## Mandatory rules

1. **File receipts first** — write under `analysis/receipts/…`, then return the path.
2. **Envelope only** — never inject full receipt JSON or tool dumps into the next `agent()` prompt.
3. **JIT read** — synthesizers/planners open only the paths they need.
4. **Ledger includes failures** — preserve every intended unit id with `status: failed` when a child
   returns null/error; do not filter failed ids before Plan or synthesis.
5. **Single writer** for `wiki/**` — parallelize only research and review lenses.
6. **No transcript dump** — do not aggregate child chat into parent context for “status”.
7. **Schema-cap summaries** — if summary grows unbounded, fail the envelope and retry the child.

## Anti-patterns

```text
parent.context += child.full_transcript
prompt = JSON.stringify(allReceipts)
JSON.stringify(findings).slice(0, 30000)   // breaks structure; still too large
```

## Suggested defaults

| Parameter | Default |
|-----------|---------|
| Envelope `summary` | ≤ 800 tokens |
| Agents per wave | 2–4 (merge before 5+) |
| Synthesis in-prompt payload | paths + digests only |
| Wiki writers | exactly one agent per write phase |

## Workflow alignment

`wiki-produce.workflow.js` uses `agent` / `parallel` / `pipeline` / `phase` / `log` / `args`. After
Plan, the host must run **`ow gate plan`** before Write. After Write/Review, run **`ow validate`**.
