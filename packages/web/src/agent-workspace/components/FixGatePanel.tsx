/**
 * Operator fix gate chrome — open kind "fix" (gate.fix).
 *
 * Buttons: Pass (accept / not a problem), Fix, Revise (+ notes), Deny.
 * Dispatches ResolveGate via parent using buildFixGateResolveCommand.
 */

import type {
  FixGateDecision,
  MergedDefectReport,
  WikiRunGate,
  WikiRunSnapshot,
} from "@okf-wiki/contract";
import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { useI18n } from "../../i18n";
import {
  buildFixGateResolveCommand,
  type FixGateDefectHint,
  fixGateContextFromSnapshot,
} from "./fix-gate";

export type FixGatePanelProps = {
  gate: WikiRunGate;
  runId: string;
  snapshot?: WikiRunSnapshot | null;
  /** Sealed defects.json when an API or parent loads it. */
  defectsReport?: MergedDefectReport | null;
  /** Optional summary sealed on the gate payload / detail. */
  gateSummary?: string | null;
  submitting?: boolean;
  commandError?: string | null;
  /** Parent dispatches the built ResolveGate command; return false to keep revise UI. */
  onResolve: (
    command: ReturnType<typeof buildFixGateResolveCommand>,
  ) => boolean | void | Promise<boolean | void>;
};

function severityVariant(
  severity: FixGateDefectHint["severity"],
): "destructive" | "secondary" | "outline" {
  if (severity === "blocking") return "destructive";
  if (severity === "major") return "secondary";
  return "outline";
}

export function FixGatePanel({
  gate,
  runId,
  snapshot = null,
  defectsReport = null,
  gateSummary = null,
  submitting = false,
  commandError = null,
  onResolve,
}: FixGatePanelProps) {
  const { t } = useI18n();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  const context = useMemo(
    () =>
      fixGateContextFromSnapshot(snapshot, {
        defectsReport,
        gate,
        gateSummary,
      }),
    [snapshot, defectsReport, gate, gateSummary],
  );

  const decide = (decision: FixGateDecision) => {
    if (decision === "revise" && !feedback.trim()) {
      setRevising(true);
      return;
    }
    const command = buildFixGateResolveCommand({
      runId,
      gateId: gate.gateId,
      payloadDigest: gate.payloadDigest,
      decision,
      ...(decision === "revise" ? { feedback: feedback.trim() } : {}),
    });
    void Promise.resolve(onResolve(command)).then((ok) => {
      if (ok === false) return;
      setRevising(false);
      setFeedback("");
    });
  };

  return (
    <div
      className="flex flex-col gap-2 border-t border-border/60 pt-2"
      data-testid="agent-fix-gate"
      data-gate-kind="fix"
      data-gate-id={gate.gateId}
      data-gate-state={gate.state}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-xs font-medium">{t.fixConfirm.title}</p>
        {context.clean === true ? (
          <Badge variant="secondary" className="text-2xs font-normal">
            {t.fixConfirm.clean}
          </Badge>
        ) : context.defects.length > 0 ? (
          <Badge variant="destructive" className="text-2xs font-normal">
            {t.fixConfirm.defectCount.replace("{n}", String(context.defects.length))}
          </Badge>
        ) : null}
      </div>

      {context.summary ? (
        <p className="text-xs text-muted-foreground" data-testid="fix-gate-summary">
          {context.summary}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t.fixConfirm.noDefectsHint}</p>
      )}

      {context.defects.length > 0 ? (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto" data-testid="fix-gate-defects">
          {context.defects.map((defect, index) => (
            <li
              key={`${defect.path ?? ""}-${defect.code ?? ""}-${index}`}
              className="rounded-md border border-border/60 px-2 py-1.5 text-2xs"
              data-testid="fix-gate-defect"
            >
              <div className="flex flex-wrap items-center gap-1">
                {defect.severity ? (
                  <Badge
                    variant={severityVariant(defect.severity)}
                    className="h-4 px-1 text-2xs font-normal"
                  >
                    {defect.severity}
                  </Badge>
                ) : null}
                {defect.code ? (
                  <span className="font-mono text-muted-foreground">{defect.code}</span>
                ) : null}
                {defect.path ? (
                  <span className="font-mono text-muted-foreground">{defect.path}</span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs leading-snug">{defect.issue}</p>
              {defect.suggestedFix ? (
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  {t.fixConfirm.suggestedFix}: {defect.suggestedFix}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {commandError ? (
        <Alert variant="destructive" data-testid="agent-gate-error">
          <AlertDescription>{commandError}</AlertDescription>
        </Alert>
      ) : null}

      {revising ? (
        <FieldGroup className="gap-2">
          <Field data-disabled={submitting || undefined}>
            <FieldLabel htmlFor="fix-gate-feedback" className="text-xs">
              {t.fixConfirm.reviseLabel}
            </FieldLabel>
            <InputGroup>
              <InputGroupTextarea
                id="fix-gate-feedback"
                data-testid="agent-gate-feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.fixConfirm.revisePlaceholder}
                disabled={submitting}
                rows={2}
                className="min-h-16 text-xs"
              />
            </InputGroup>
          </Field>
        </FieldGroup>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          data-testid="agent-gate-pass"
          disabled={submitting || revising}
          onClick={() => decide("pass")}
        >
          {submitting ? t.fixConfirm.working : t.fixConfirm.pass}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="agent-gate-fix"
          disabled={submitting || revising}
          onClick={() => decide("fix")}
        >
          {t.fixConfirm.fix}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={revising ? "agent-gate-revise-submit" : "agent-gate-revise"}
          disabled={submitting || (revising && !feedback.trim())}
          onClick={() => {
            if (!revising) {
              setRevising(true);
            } else {
              decide("revise");
            }
          }}
        >
          {revising ? t.fixConfirm.reviseSubmit : t.fixConfirm.revise}
        </Button>
        {revising ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="agent-gate-revise-cancel"
            disabled={submitting}
            onClick={() => {
              setRevising(false);
              setFeedback("");
            }}
          >
            {t.common.cancel}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="agent-gate-deny"
            disabled={submitting}
            onClick={() => decide("deny")}
          >
            {t.fixConfirm.deny}
          </Button>
        )}
      </div>
    </div>
  );
}
