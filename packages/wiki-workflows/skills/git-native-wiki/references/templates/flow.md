# Flow Page Skeleton

Use only for a Flow page selected by the finalized WikiSpec. Structure the page
around these sections when source evidence exists:

1. Trigger, actors, and scope
2. Ordered happy path
3. Asynchronous, retry, or failure behavior
4. State or data effects
5. Links to the owning components

Use a `sequenceDiagram` when the source establishes ordered interaction across
components. Use `stateDiagram` only for an explicit lifecycle or transition
model. A flowchart is suitable for a non-temporal branch or pipeline, not as a
substitute for a sequence.
