/**
 * Unify setPhase + updateRunRecord + optional graphOwner.persist for Wiki Run
 * phase transitions. Shell owns details mutation via setPhase; this controller
 * is the single call site for the triple.
 */

import {
  recordStatusFromPhase,
  type WikiProduceToolDetails,
  type WikiRunPhase,
  type WikiRunSpec,
} from "@okf-wiki/contract";

export type AdvancePhaseOptions = {
  /** Patch tool details beyond the projected status. */
  extra?: Omit<Partial<WikiProduceToolDetails>, "status">;
  /**
   * Record patch fields beyond status projection.
   * `false` = skip Run Record write (e.g. pre-runId freezing, mid-plan setPhase).
   * Default: write `{ status: recordStatusFromPhase(phase) }` (plus any fields).
   */
  record?:
    | false
    | {
        spec?: WikiRunSpec;
        pages?: string[];
        summary?: string;
        error?: string | null;
      };
  /** Default false for mid-flight; terminal sites pass true. */
  persist?: boolean;
};

export type AdvancePhase = (
  phase: WikiRunPhase,
  opts?: AdvancePhaseOptions,
) => Promise<void>;

export type RunRecordPatch = {
  status?: ReturnType<typeof recordStatusFromPhase>;
  spec?: WikiRunSpec;
  pages?: string[];
  summary?: string;
  error?: string | null;
};

export type CreateRunPhaseControllerInput = {
  setPhase: (
    phase: WikiRunPhase,
    extra?: Omit<Partial<WikiProduceToolDetails>, "status">,
  ) => void;
  /** Bound Run Record patcher (rootPath + runId closed over by the caller). */
  updateRunRecord: (patch: RunRecordPatch) => Promise<unknown>;
  persist: () => Promise<void>;
  /** Whether a durable Run Record write is possible (runId present, etc.). */
  canWriteRecord: () => boolean;
};

export type RunPhaseController = {
  advancePhase: AdvancePhase;
};

/**
 * Factory used by the runWiki shell. Gate loops receive only `advancePhase`.
 * Record write failures propagate (gate abort-on-record-failure depends on this).
 */
export function createRunPhaseController(
  input: CreateRunPhaseControllerInput,
): RunPhaseController {
  return {
    async advancePhase(phase, opts) {
      input.setPhase(phase, opts?.extra);
      const recordFields = opts?.record;
      if (recordFields !== false && input.canWriteRecord()) {
        await input.updateRunRecord({
          status: recordStatusFromPhase(phase),
          ...(recordFields ?? {}),
        });
      }
      if (opts?.persist) {
        await input.persist();
      }
    },
  };
}
