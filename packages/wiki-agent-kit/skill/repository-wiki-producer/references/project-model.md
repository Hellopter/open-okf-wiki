# Project Knowledge Model

Compile survey receipts and the Discovery Map into `analysis/project-model.json`. The model is the
semantic intermediate between discovery and the Wiki Spec. Keep the full body on disk; never paste
it through parent workflow context.

## Required top-level shape

```json
{
  "version": 1,
  "productPurpose": "One sentence on the product job-to-be-done",
  "actors": [],
  "domains": [],
  "capabilities": [],
  "entities": [],
  "rules": [],
  "flows": [],
  "modules": [],
  "dataModels": [],
  "mappings": [],
  "conflicts": [],
  "gaps": [],
  "openQuestions": []
}
```

Every important object should carry `id`, a short `title`/`summary`, and `evidenceIds[]` when the
claim is direct. Arrays may be empty only when the project truly has no evidence for that class;
L0 utility libraries may leave many arrays empty and record the reason in `gaps` or
`openQuestions`.

## Flow contract

Each flow object must be executable knowledge, not a label:

| Field | Requirement |
|---|---|
| `id`, `title` | Stable non-empty identifiers for Spec binding |
| `trigger` | What starts the journey |
| `outcome` | Observable success result |
| `preconditions` | Optional, but record when source shows them |
| `steps[]` | Ordered, non-empty; each step has `order` and `summary` |
| `branches[]` / `failures[]` | Alternate and error exits; if unknown, add a gap |
| `stateChanges[]` | Entity/status transitions |
| `sideEffects[]` | Writes, messages, external calls |
| `participatingKnowledgeIds[]` | Domains, modules, entities, rules involved |
| `evidenceIds[]` | At least one direct evidence id for real flows |

Do not invent missing steps. If only the entry is known, keep a short flow and add a structured
gap describing the unread path.

## Mappings, conflicts, gaps

- `mappings[]` connect business ids to modules, APIs, or data models.
- `conflicts[]` keep disagreeing doc/code claims side by side with evidence.
- `gaps[]` and `openQuestions[]` are first-class; the Planner may cancel coverage or mark pages
  non-critical because of them, but must not erase them.

## Planner handoff

The Planner reads this file as the main semantic input. Spec pages bind `knowledgeIds` and
`evidenceIds` from the model rather than inventing a fresh ontology during writing.
