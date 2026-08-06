# Business Discovery

Extract reader-useful business knowledge from frozen sources. This method feeds the Discovery Map
and the Project Knowledge Model. Do not invent business intent from directory names alone.

## Analysis order

1. **Project identity** — README, package/module names, entry configs, database names, deploy
   descriptors. Record agreement and conflict.
2. **Actors and goals** — who uses the system, what job they complete, which external systems are
   involved.
3. **Business language** — stable nouns/verbs, status words, error codes, event names, and glossary
   candidates.
4. **Entries** — HTTP/RPC/message/CLI/UI/cron entry points that start real work.
5. **Flows** — for each important entry, follow application service, domain rules, persistence, and
   side effects until the observable outcome.
6. **Rules and states** — validation, invariants, enums/status strings, branch conditions,
   retries, compensation, and transaction boundaries.
7. **Data ownership** — entities, tables/collections, DTOs/events, authoritative stores.
8. **Doc/code contrast** — design claims versus implementation; never silently prefer one side.
9. **Gaps** — anything unproven becomes a gap or open question, never a fabricated fact.

## Minimum evidence per claim class

| Claim | Minimum evidence |
|---|---|
| Product purpose | README/docs plus at least one runtime entry or module ownership clue |
| Domain boundary | packages/modules/APIs that share language and ownership |
| Capability | entry + implementing service/use-case path |
| Entity/state | type/schema/table or explicit status transitions in code |
| Rule | validation/branch/exception path with line evidence |
| Flow step | callable path with source span; inferred hops must be labeled |
| Conflict | at least two disagreeing sources with paths |

## Output discipline

- Prefer business meaning first, code location second.
- Keep identifiers, API paths, and config keys untranslated.
- Preserve failed survey units; do not drop them to make the map look clean.
- Multi-source journeys set `crossSource: true` and name each participating source/surface.
- Write full findings to disk receipts; return only compact envelopes to the parent.
