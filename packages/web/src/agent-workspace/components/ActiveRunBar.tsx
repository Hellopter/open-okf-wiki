/**
 * Compatibility Action Dock controller.
 *
 * The legacy shell still mounts this component, while new Workbench hosts can
 * reuse ActiveRunSummary, RunPicker, and GateAction independently. This file
 * remains the one owner of the selected Run projection and Gate dispatch.
 */

import type { ResolveGateCommand } from "@okf-wiki/contract";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { dispatchWikiRunCommand, type WikiRunListItem } from "../../api";
import { useI18n } from "../../i18n";
import { useWikiRunProjection } from "../hooks/WikiRunProjectionContext";
import { selectMatchingProjection } from "../hooks/wiki-run-projection";
import { wikiRunToViewModel } from "../run-graph/wiki-run-view-model";
import { ActiveRunSummary } from "./ActiveRunSummary";
import { GateAction } from "./GateAction";
import {
  gateActionPresentationForWidth,
  type GateActionPresentation,
} from "./gate-action-presentation";
import { gateActionTitle } from "./gate-action";
import { selectPrimaryOpenGate } from "./fix-gate";
import { RunPicker } from "./RunPicker";
import { isRunCancellable } from "./run-actions";

export type ActiveRunBarProps = {
  workspaceId: string;
  rootPath?: string;
  recentRuns?: WikiRunListItem[];
  /** Local: whether graph/plan details are expanded under the bar. */
  graphOpen: boolean;
  onGraphOpenChange: (open: boolean) => void;
  /** Hide when the host presents the URL-only Run picker elsewhere. */
  showRunPicker?: boolean;
  /** Hide when the host presents the read-only Run Cockpit trigger elsewhere. */
  showInspectorTrigger?: boolean;
  className?: string;
};

function useGateActionPresentation(): GateActionPresentation {
  const [presentation, setPresentation] = useState<GateActionPresentation>(() =>
    typeof window === "undefined" ? "dock" : gateActionPresentationForWidth(window.innerWidth),
  );

  useEffect(() => {
    const updatePresentation = () => {
      setPresentation(gateActionPresentationForWidth(window.innerWidth));
    };
    window.addEventListener("resize", updatePresentation);
    updatePresentation();
    return () => window.removeEventListener("resize", updatePresentation);
  }, []);

  return presentation;
}

export function ActiveRunBar({
  workspaceId,
  rootPath,
  recentRuns = [],
  graphOpen,
  onGraphOpenChange,
  showRunPicker = true,
  showInspectorTrigger = true,
  className,
}: ActiveRunBarProps) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get("run");
  const shellProjection = useWikiRunProjection();
  const wikiRun = selectMatchingProjection(shellProjection, runId);
  const snapshot = wikiRun.snapshot;
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);
  const primaryGate = viewModel ? selectPrimaryOpenGate(viewModel.openGates) : null;
  const [submitting, setSubmitting] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const gatePresentation = useGateActionPresentation();

  useEffect(() => {
    setSubmitting(false);
    setCommandError(null);
    setGateOpen(false);
  }, [runId]);

  useEffect(() => {
    setGateOpen(false);
  }, [gatePresentation, primaryGate?.gateId]);

  if (!runId) return null;

  const selectRun = (nextRunId: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("rootPath");
        next.set("run", nextRunId);
        next.delete("attempt");
        return next;
      },
      { replace: true },
    );
  };

  const dispatchCommand = async (
    command: Parameters<typeof dispatchWikiRunCommand>[1],
  ): Promise<boolean> => {
    if (!workspaceId || submitting) return false;
    setSubmitting(true);
    setCommandError(null);
    try {
      await dispatchWikiRunCommand(workspaceId, command, rootPath);
      return true;
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const resolveGate = (command: ResolveGateCommand) => dispatchCommand(command);
  const currentState = snapshot?.state ?? recentRuns.find((run) => run.runId === runId)?.state;
  const loading = !wikiRun.ready && !wikiRun.error;
  const needsOperator = currentState === "waiting_for_operator" || Boolean(primaryGate);
  const canCancel = isRunCancellable(currentState, Boolean(wikiRun.error));
  const gateTitle = primaryGate ? gateActionTitle(primaryGate.kind, t) : null;
  const gateMovesToOverlay = Boolean(primaryGate && gatePresentation !== "dock");
  const openGate = () => {
    onGraphOpenChange(false);
    setGateOpen(true);
  };
  const gateAction = primaryGate ? (
    <GateAction
      gate={primaryGate}
      runId={runId}
      snapshot={snapshot}
      submitting={submitting}
      commandError={commandError}
      onResolve={resolveGate}
    />
  ) : null;

  return (
    <section
      className={cn(
        "flex shrink-0 flex-col gap-3 border-t border-border bg-muted/20 px-3 py-2.5",
        needsOperator && "border-t-primary/40 bg-primary/5",
        className,
      )}
      data-testid="active-run-bar"
      data-run-id={runId}
      data-run-state={currentState}
      data-graph-open={graphOpen ? "true" : "false"}
    >
      <ActiveRunSummary
        runId={runId}
        state={currentState}
        summary={primaryGate ? gateActionTitle(primaryGate.kind, t) : undefined}
        loading={loading}
        reconnecting={wikiRun.connectionStatus === "reconnecting"}
        graphOpen={graphOpen}
        onGraphOpenChange={showInspectorTrigger ? onGraphOpenChange : undefined}
        onCancelRun={
          canCancel && !gateMovesToOverlay
            ? () => void dispatchCommand({ type: "cancel_run", commandId: crypto.randomUUID(), runId })
            : undefined
        }
        cancelDisabled={submitting || currentState === "cancelling"}
      >
        {showRunPicker ? (
          <RunPicker
            runId={runId}
            recentRuns={recentRuns}
            onSelectRun={selectRun}
            menuSide="top"
          />
        ) : null}
      </ActiveRunSummary>

      {wikiRun.error ? (
        <Alert variant="destructive" data-testid="active-run-error">
          <AlertDescription>{wikiRun.error}</AlertDescription>
        </Alert>
      ) : null}

      {gateMovesToOverlay && gateTitle ? (
        <Button
          type="button"
          size="sm"
          data-testid="active-run-open-gate"
          aria-haspopup="dialog"
          aria-expanded={gateOpen}
          onClick={openGate}
        >
          <ExternalLinkIcon data-icon="inline-start" />
          {t.agentWorkspace.openGate}
        </Button>
      ) : null}

      {primaryGate ? (
        gatePresentation === "dock" ? gateAction : null
      ) : commandError ? (
        <Alert variant="destructive" data-testid="agent-gate-error">
          <AlertDescription>{commandError}</AlertDescription>
        </Alert>
      ) : null}

      {primaryGate && gatePresentation === "sheet" && gateTitle ? (
        <Sheet
          open={gateOpen}
          onOpenChange={(open) => {
            setGateOpen(open);
            if (open) onGraphOpenChange(false);
          }}
        >
          <SheetContent
            side="right"
            className="w-[min(100%,34rem)] max-w-none gap-0 p-0"
            data-testid="agent-gate-sheet"
          >
            <SheetHeader className="border-b border-border">
              <SheetTitle>{gateTitle}</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 overflow-y-auto px-4 py-4">{gateAction}</div>
          </SheetContent>
        </Sheet>
      ) : null}

      {primaryGate && gatePresentation === "drawer" && gateTitle ? (
        <Drawer
          open={gateOpen}
          onOpenChange={(open) => {
            setGateOpen(open);
            if (open) onGraphOpenChange(false);
          }}
          showSwipeHandle
        >
          <DrawerContent
            className="pb-[env(safe-area-inset-bottom)]"
            data-testid="agent-gate-drawer"
          >
            <DrawerHeader>
              <DrawerTitle>{gateTitle}</DrawerTitle>
            </DrawerHeader>
            <div className="min-h-0 overflow-y-auto px-4 pb-4">{gateAction}</div>
          </DrawerContent>
        </Drawer>
      ) : null}
    </section>
  );
}
