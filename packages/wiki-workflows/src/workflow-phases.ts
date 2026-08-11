/**
 * Single source of truth for user-visible Wiki workflow phases.
 *
 * Node kinds map onto coarser dashboard stages (e.g. synthesis → plan,
 * validate|review|finalize → verify). Pure module: no Pi imports.
 */

import type { WikiNodeKind } from "./workflow-types.js";

export interface WikiWorkflowPhase {
  id: string;
  title: string;
  conditional: boolean;
  waitingMessage: string;
}

/**
 * Declared pipeline stages. The dashboard shows this complete map even before
 * the engine has dynamically queued every subagent.
 */
export const WIKI_WORKFLOW_PHASES = [
  {
    id: "inspect",
    title: "Inspect",
    conditional: false,
    waitingMessage: "Waiting for the run to inspect the repository.",
  },
  {
    id: "research",
    title: "Research",
    conditional: false,
    waitingMessage: "Waiting for repository inspection to complete.",
  },
  {
    id: "plan",
    title: "Plan",
    conditional: false,
    waitingMessage: "Waiting for source-grounded research receipts.",
  },
  {
    id: "write",
    title: "Write",
    conditional: false,
    waitingMessage: "Waiting for a finalized Wiki specification.",
  },
  {
    id: "verify",
    title: "Verify",
    conditional: false,
    waitingMessage: "Waiting for target pages to be written.",
  },
] as const satisfies readonly WikiWorkflowPhase[];

export type WikiWorkflowPhaseId = (typeof WIKI_WORKFLOW_PHASES)[number]["id"];

/** Compat alias used by the UI stage rows. */
export type WikiWorkflowStage = WikiWorkflowPhase;

/** Compat alias — prefer WIKI_WORKFLOW_PHASES for new code. */
export const WIKI_WORKFLOW_STAGES: readonly WikiWorkflowStage[] = WIKI_WORKFLOW_PHASES;

export function phaseIdForKind(kind: WikiNodeKind): WikiWorkflowPhaseId {
  switch (kind) {
    case "inspect":
      return "inspect";
    case "research":
      return "research";
    case "synthesis":
      return "plan";
    case "write":
      return "write";
    case "validate":
    case "review":
    case "finalize":
      return "verify";
  }
}

export function phaseTitleForKind(kind: WikiNodeKind): string {
  const id = phaseIdForKind(kind);
  const phase = WIKI_WORKFLOW_PHASES.find((item) => item.id === id);
  return phase?.title ?? id;
}

/** Convenience `{ id, title }` for queueNode / newNode phase arguments. */
export function phaseMetaForKind(kind: WikiNodeKind): { id: WikiWorkflowPhaseId; title: string } {
  return { id: phaseIdForKind(kind), title: phaseTitleForKind(kind) };
}

/** @deprecated Prefer phaseMetaForKind — same return shape. */
export const phaseRefForKind = phaseMetaForKind;
