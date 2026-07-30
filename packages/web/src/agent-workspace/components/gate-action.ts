import type { ResolveGateCommand, WikiRunGate, WikiRunGateKind } from "@okf-wiki/contract";

type GateActionCopy = {
  planConfirm: { title: string };
  runStatus: { awaiting_publication: string };
  fixConfirm: { title: string };
  operatorInput: { title: string };
};

export function gateActionTitle(kind: WikiRunGateKind, t: GateActionCopy): string {
  if (kind === "plan") return t.planConfirm.title;
  if (kind === "publication") return t.runStatus.awaiting_publication;
  if (kind === "fix") return t.fixConfirm.title;
  return t.operatorInput.title;
}

export type BuildGateActionResolveCommandInput = {
  runId: string;
  gate: WikiRunGate;
  decision: "approve" | "deny" | "revise" | "answer";
  feedback?: string;
  answer?: string;
  commandId?: string;
};

/** Builds the non-fix GateAction command and keeps answer/revise payloads scoped. */
export function buildGateActionResolveCommand(
  input: BuildGateActionResolveCommandInput,
): ResolveGateCommand {
  if (input.gate.kind === "fix") {
    throw new Error("fix gates use buildFixGateResolveCommand");
  }
  const feedback = input.feedback?.trim() ?? "";
  const answer = input.answer?.trim() ?? "";
  if (input.decision === "revise" && !feedback) {
    throw new Error("gate revise requires feedback");
  }
  if (input.decision === "answer" && !answer) {
    throw new Error("operator input requires an answer");
  }
  return {
    type: "resolve_gate",
    commandId: input.commandId?.trim() || crypto.randomUUID(),
    runId: input.runId,
    gateId: input.gate.gateId,
    gateKind: input.gate.kind,
    payloadDigest: input.gate.payloadDigest,
    decision: input.decision,
    ...(input.decision === "revise" ? { feedback } : {}),
    ...(input.decision === "answer" ? { answer } : {}),
  };
}
