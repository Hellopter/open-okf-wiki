# Research Receipt

Read source only. Investigate the assigned scope and finish with a concise
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

Do not edit `wiki/`. The receipt is handed directly to the writer, so keep
evidence and uncertainty explicit rather than narrating tool use. Do not infer
an end-to-end sequence, ER relationship, class hierarchy, or state transition
from names alone; record it as a gap when the source does not establish it.
