---
name: wiki-production
description: Isolated Wiki Lead session brief for one source-grounded production run.
---

# Wiki production Lead

The host already started this Run and mounted its logical file slots under
`.okf-wiki/current/`. Use Pi `read`, `write`, and `edit` on those files, then
submit only the small control calls described below. The host binds every slot
to its durable Source, Task Receipt, and Candidate state.

1. Read `.okf-wiki/current/board.md`. It is the read-only authority for the
   next ready wave and remaining work.
2. For discovery, read every host-created
   `.okf-wiki/current/research/source-NNN.md` slot. Add concise research
   direction in place only when the generated direction needs refinement, then
   call `wiki_delegate_start` with no arguments. The host binds slots to pinned
   Sources and queues the complete ready wave.
3. After `wiki_delegate_start`, continue useful Lead work. The host follows up
   when the wave settles; re-read the board then. Use `wiki_delegate_collect`
   only for a non-blocking snapshot (`timeoutSeconds: 0`) or one long wait
   (`until: "all"`). Do not poll with short timeouts. When evidence prose is
   needed, use Pi `read` on the read-only artifact or resource paths shown on
   the board. A failed or incomplete Task Receipt is missing coverage, never
   evidence of absence. When the board makes a supplement ready, call
   `wiki_delegate_start` again with no arguments; the host derives its scope
   from current blockers.
4. When research is ready, edit the host-provided
   `.okf-wiki/current/taxonomy.yaml` in place. Preserve its shape, keep each
   `sourceScopeId` as the matching Wiki source folder, and reconcile
   source-local domains, cross-source relations, conflicts, and minority
   evidence. Call `wiki_taxonomy` with no arguments; it consumes that file.
   If the host rejects the file, fix every named defect in the same rewrite,
   then submit again.
5. Read [topology](references/topology.md), edit
   `.okf-wiki/current/wiki-spec.yaml` in place under the host-written source
   folders, then call `wiki_plan` with no arguments. It consumes that file.
   If the host rejects the file, fix every named defect in the same rewrite,
   then submit again.
6. Re-read the board and call `wiki_delegate_start` with no arguments for each
   ready write or review wave. The host derives tasks, Candidate paths,
   upstream artifacts, and review assignments. Collect each wave before
   advancing. A write or plan revision invalidates prior review passes.
7. When the board shows the Candidate complete with current passing review
   coverage, write a concise completion summary to
   `.okf-wiki/current/completion.md`, then call `wiki_finish` with no arguments.
   If the host rejects, fix every named defect, then finish again.

`wiki_delegate_cancel` accepts only an optional short `reasonCode`. Use it when
the current pending wave is no longer useful. Business prose belongs in the
fixed files, while `wiki_*` JSON carries only status, wait controls, verdicts,
or a short reason code. Use the host-provided slots in place; the host owns slot
creation, naming, Source binding, and durable identities.

## References

- [Topology](references/topology.md) - before editing `wiki-spec.yaml`
- `.okf-wiki/current/board.md` - before every workflow transition
- [Evidence](references/common.md)
- [Researcher brief](briefs/researcher.md) and [research](references/research.md)
- [Writer brief](briefs/writer.md) and [writing](references/write.md)
- [Reviewer brief](briefs/reviewer.md) and [review](references/review.md)
