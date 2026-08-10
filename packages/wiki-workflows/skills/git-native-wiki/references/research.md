# Research Receipt

Read only the declared `sourcePaths` in the assigned scope. The tool policy
enforces this boundary; do not attempt to inspect `wiki/`, the workspace root,
or another configured source. Investigate the assigned scope and finish with a concise
Markdown receipt, even when there are no findings. Focus on evidence a
synthesis coordinator can assign safely to one DomainPacket. Use this shape:

```md
## Findings
- Verified claim. Source: `project/path.ext#L10-L24`

## Relationships And Flows
- Verified component, call, event, or data relationship. Source: `project/path.ext#L10-L24`

## State And Data Evidence
- Verified transition, lifecycle rule, entity, ownership, or persistence relationship. Source: `project/path.ext#L10-L24`

## Diagram Evidence
- Candidate diagram type and the specific reader question it could answer, or `Not applicable` with a reason.

## Gaps
- Evidence that could not be established.

## Writer Guidance
- What the assigned domain should explain, link to, or avoid claiming.
```

Do not edit `wiki/`. The receipt is handed directly to the writer and
synthesizer as Markdown evidence, so keep evidence and uncertainty explicit
rather than narrating tool use. Keep the entire receipt within 16 KiB UTF-8:
prefer precise citations and short findings over copied source or long prose.
Do not infer an end-to-end sequence, ER relationship, class hierarchy, or
state transition from names alone; record it as a gap when the source does not
establish it.
