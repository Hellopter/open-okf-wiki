import type { ResolveGateCommand, WikiRunGate, WikiRunSnapshot } from "@okf-wiki/contract";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { FixGatePanel } from "./FixGatePanel";
import { buildGateActionResolveCommand, gateActionTitle } from "./gate-action";

export type GateActionProps = {
  gate: WikiRunGate;
  runId: string;
  snapshot?: WikiRunSnapshot | null;
  submitting?: boolean;
  commandError?: string | null;
  /** The controller owns dispatch/CAS; this surface only creates a gate command. */
  onResolve: (command: ResolveGateCommand) => Promise<boolean>;
  className?: string;
};

/**
 * The only Gate mutation surface. Responsive hosts may relocate this component,
 * but must mount it once and reuse the controller callback.
 */
export function GateAction({
  gate,
  runId,
  snapshot = null,
  submitting = false,
  commandError = null,
  onResolve,
  className,
}: GateActionProps) {
  const { t } = useI18n();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [operatorAnswer, setOperatorAnswer] = useState("");

  useEffect(() => {
    setRevising(false);
    setFeedback("");
    setOperatorAnswer("");
  }, [gate.gateId]);

  const resolve = async (
    decision: "approve" | "deny" | "revise" | "answer",
    value?: string,
  ): Promise<boolean> => {
    const command = buildGateActionResolveCommand({
      runId,
      gate,
      decision,
      ...(decision === "revise" ? { feedback: value } : {}),
      ...(decision === "answer" ? { answer: value } : {}),
    });
    return onResolve(command);
  };

  if (gate.kind === "fix") {
    return (
      <FixGatePanel
        gate={gate}
        runId={runId}
        snapshot={snapshot}
        submitting={submitting}
        commandError={commandError}
        onResolve={onResolve}
      />
    );
  }

  const isOperatorInput = gate.kind === "operator_input";
  const isPlan = gate.kind === "plan";
  const showFeedback = isPlan && revising;
  const answer = operatorAnswer.trim();
  const title = gateActionTitle(gate.kind, t);

  return (
    <section
      className={cn("flex flex-col gap-3 border-t border-border/60 pt-3", className)}
      data-testid={`agent-${gate.kind}-gate`}
      data-gate-kind={gate.kind}
      data-gate-id={gate.gateId}
      aria-labelledby={`gate-action-${gate.gateId}`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`gate-action-${gate.gateId}`} className="text-sm font-medium">
          {title}
        </h2>
        {gate.detail?.summary ? (
          <p
            className="whitespace-pre-wrap text-xs text-muted-foreground"
            data-testid={isOperatorInput ? "agent-operator-input-question" : undefined}
          >
            {gate.detail.summary}
          </p>
        ) : isOperatorInput ? (
          <p className="text-xs text-muted-foreground">{t.operatorInput.questionFallback}</p>
        ) : null}
      </div>

      {commandError ? (
        <Alert variant="destructive" data-testid="agent-gate-error">
          <AlertDescription>{commandError}</AlertDescription>
        </Alert>
      ) : null}

      {isOperatorInput ? (
        <FieldGroup className="gap-2">
          <Field data-disabled={submitting || undefined}>
            <FieldLabel htmlFor="active-run-operator-answer" className="text-xs">
              {t.operatorInput.answerLabel}
            </FieldLabel>
            <InputGroup>
              <InputGroupTextarea
                id="active-run-operator-answer"
                data-testid="agent-operator-answer"
                value={operatorAnswer}
                onChange={(event) => setOperatorAnswer(event.target.value)}
                placeholder={t.operatorInput.answerPlaceholder}
                disabled={submitting}
                rows={2}
                className="min-h-14 text-xs"
              />
            </InputGroup>
          </Field>
        </FieldGroup>
      ) : null}

      {showFeedback ? (
        <FieldGroup className="gap-2">
          <Field data-disabled={submitting || undefined}>
            <FieldLabel htmlFor="active-run-gate-feedback" className="text-xs">
              {t.planConfirm.reviseLabel}
            </FieldLabel>
            <InputGroup>
              <InputGroupTextarea
                id="active-run-gate-feedback"
                data-testid="agent-gate-feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.planConfirm.revisePlaceholder}
                disabled={submitting}
                rows={2}
                className="min-h-14 text-xs"
              />
            </InputGroup>
          </Field>
        </FieldGroup>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {isOperatorInput ? (
          <Button
            type="button"
            size="sm"
            data-testid="agent-operator-answer-submit"
            disabled={submitting || !answer}
            onClick={() => {
              void resolve("answer", answer).then((ok) => {
                if (ok) setOperatorAnswer("");
              });
            }}
          >
            {submitting ? t.operatorInput.working : t.operatorInput.submit}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              data-testid="agent-gate-approve"
              disabled={submitting || revising}
              onClick={() => void resolve("approve")}
            >
              {submitting
                ? t.planConfirm.working
                : isPlan
                  ? t.planConfirm.approve
                  : t.planConfirm.chipPublish}
            </Button>
            {isPlan ? (
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
                    void resolve("revise", feedback.trim()).then((ok) => {
                      if (ok) {
                        setRevising(false);
                        setFeedback("");
                      }
                    });
                  }
                }}
              >
                {revising ? t.planConfirm.reviseSubmit : t.planConfirm.revise}
              </Button>
            ) : null}
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
                onClick={() => void resolve("deny")}
              >
                {isPlan ? t.planConfirm.decline : t.planConfirm.chipKeepStaging}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
