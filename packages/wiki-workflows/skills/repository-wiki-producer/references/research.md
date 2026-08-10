# Research Receipt

Read only the `sourcePaths` in the assigned scope. A scope may span multiple
declared source roots. Investigate the task and write a concise Markdown
receipt even when no evidence is found. Use exactly these sections:

```md
## Verified Evidence
- Verified claim. Source: `project/path.ext#L10-L24`

## Relationships
- Verified component, call, event, or data relationship. Source: `project/path.ext#L10-L24`

## State And Data
- Verified transition, lifecycle, entity, ownership, or persistence fact. Source: `project/path.ext#L10-L24`

## Gaps
- Evidence that could not be established.
```

Do not edit `wiki/`. Write the receipt to the exact handoff path supplied by
the workflow. Prefer precise citations and short findings over copied source or
tool narration. Keep the receipt below 64 KiB and never return it as JSON.

Do not infer an end-to-end sequence, relationship, hierarchy, or state
transition from names alone. Record unestablished claims as gaps.
