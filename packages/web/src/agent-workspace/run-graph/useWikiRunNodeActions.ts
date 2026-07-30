/**
 * Shared node-dialog selection + RetryFailedNode / RerunNode dispatch.
 *
 * Used by RunInspectorDialog control chrome (shell-owned). WikiProduceGatePanel
 * stays slim (receipt + plan gate HITL + "View run") and does not own this surface.
 *
 * Command state is resource-keyed (Phase 6):
 *   `run:<id>:cancel` | `gate:<id>:resolve` | `node:<id>:retry`
 * HTTP accept/reject is admission only; Run SSE is truth.
 */

import type {
  NodeAttempt,
  RunCommand,
  WikiRunAttempt,
  WikiRunNode,
  WikiRunSnapshot,
} from "@okf-wiki/contract";
import { useCallback, useMemo, useState } from "react";
import { dispatchWikiRunCommand } from "../../api";
import { projectWikiAttempt } from "./wiki-run-view-model";

/** Resource-keyed command state (Phase 6). */
export type CommandKey =
  | `run:${string}:cancel`
  | `gate:${string}:resolve`
  | `node:${string}:retry`
  | `node:${string}:rerun`
  | string;

function commandKeyFor(command: RunCommand): CommandKey {
  switch (command.type) {
    case "cancel_run":
      return `run:${command.runId}:cancel`;
    case "resolve_gate":
      return `gate:${command.gateId}:resolve`;
    case "retry_failed_node":
      return `node:${command.nodeKey}:retry`;
    case "rerun_node":
      return `node:${command.nodeKey}:rerun`;
    default:
      return `run:${"runId" in command ? String(command.runId) : "unknown"}:${command.type}`;
  }
}

export type UseWikiRunNodeActionsArgs = {
  workspaceId: string;
  rootPath?: string;
  runId: string | null;
  snapshot: WikiRunSnapshot | null;
};

export type UseWikiRunNodeActionsResult = {
  dialogNodeKey: string | null;
  dialogAttemptId: string | null;
  dialogNode: WikiRunNode | undefined;
  dialogWikiAttempt: WikiRunAttempt | undefined;
  dialogAttempt: NodeAttempt | undefined;
  dialogLabel: string;
  relatedAttempts: NodeAttempt[];
  submitting: boolean;
  commandError: string | null;
  canRetryDialog: boolean;
  canRerunDialog: boolean;
  openNode: (nodeKey: string) => void;
  setDialogAttemptId: (attemptId: string | null) => void;
  closeDialog: () => void;
  clearCommandError: () => void;
  retryFailed: (node: WikiRunNode, attempt: WikiRunAttempt) => Promise<boolean>;
  rerunNode: (node: WikiRunNode) => Promise<boolean>;
  dispatchCommand: (command: RunCommand) => Promise<boolean>;
};

export function useWikiRunNodeActions({
  workspaceId,
  rootPath,
  runId,
  snapshot,
}: UseWikiRunNodeActionsArgs): UseWikiRunNodeActionsResult {
  const [dialogNodeKey, setDialogNodeKey] = useState<string | null>(null);
  const [dialogAttemptId, setDialogAttemptId] = useState<string | null>(null);
  /** Resource-keyed in-flight / error state (Phase 6). */
  const [commandStates, setCommandStates] = useState<
    Record<string, { submitting: boolean; error: string | null }>
  >({});
  const submitting = Object.values(commandStates).some((s) => s.submitting);
  const commandError =
    Object.values(commandStates)
      .map((s) => s.error)
      .find((e) => e != null) ?? null;

  const relatedAttempts = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return [] as NodeAttempt[];
    return snapshot.attempts
      .filter((a) => a.nodeKey === dialogNodeKey)
      .sort((a, b) => a.runIndex - b.runIndex)
      .map(projectWikiAttempt);
  }, [dialogNodeKey, snapshot]);

  const dialogWikiAttempt = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return undefined as WikiRunAttempt | undefined;
    const forNode = snapshot.attempts
      .filter((a) => a.nodeKey === dialogNodeKey)
      .sort((a, b) => a.runIndex - b.runIndex);
    if (dialogAttemptId) {
      return forNode.find((a) => a.attemptId === dialogAttemptId) ?? forNode.at(-1);
    }
    return forNode.at(-1);
  }, [dialogAttemptId, dialogNodeKey, snapshot]);

  const dialogNode: WikiRunNode | undefined = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return undefined;
    return snapshot.nodes.find((n) => n.key === dialogNodeKey);
  }, [dialogNodeKey, snapshot]);

  const dialogAttempt = dialogWikiAttempt ? projectWikiAttempt(dialogWikiAttempt) : undefined;
  const dialogLabel = dialogNodeKey ?? "";

  const openNode = useCallback(
    (nodeKey: string) => {
      const latest = snapshot?.attempts
        .filter((a) => a.nodeKey === nodeKey)
        .sort((a, b) => a.runIndex - b.runIndex)
        .at(-1);
      setDialogNodeKey(nodeKey);
      setDialogAttemptId(latest?.attemptId ?? null);
    },
    [snapshot],
  );

  const closeDialog = useCallback(() => {
    setDialogNodeKey(null);
    setDialogAttemptId(null);
  }, []);

  const clearCommandError = useCallback(() => {
    setCommandStates({});
  }, []);

  const dispatchCommand = useCallback(
    async (command: RunCommand): Promise<boolean> => {
      if (!workspaceId) return false;
      const key = commandKeyFor(command);
      let blocked = false;
      // Allow concurrent commands on different resources; block same key.
      setCommandStates((prev) => {
        if (prev[key]?.submitting) {
          blocked = true;
          return prev;
        }
        return {
          ...prev,
          [key]: { submitting: true, error: null },
        };
      });
      if (blocked) return false;
      try {
        // HTTP accept/reject is admission only; Run SSE is truth.
        await dispatchWikiRunCommand(workspaceId, command, rootPath);
        setCommandStates((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return true;
      } catch (error) {
        setCommandStates((prev) => ({
          ...prev,
          [key]: {
            submitting: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
        return false;
      }
    },
    [workspaceId, rootPath],
  );

  const retryFailed = useCallback(
    async (node: WikiRunNode, attempt: WikiRunAttempt): Promise<boolean> => {
      if (!runId) return false;
      return dispatchCommand({
        type: "retry_failed_node",
        commandId: crypto.randomUUID(),
        runId,
        nodeKey: node.key,
        generation: node.generation,
        attemptId: attempt.attemptId,
      });
    },
    [runId, dispatchCommand],
  );

  const rerunNode = useCallback(
    async (node: WikiRunNode): Promise<boolean> => {
      if (!runId) return false;
      return dispatchCommand({
        type: "rerun_node",
        commandId: crypto.randomUUID(),
        runId,
        nodeKey: node.key,
        generation: node.generation,
      });
    },
    [runId, dispatchCommand],
  );

  const canRetryDialog = Boolean(
    dialogNode &&
      dialogWikiAttempt &&
      dialogNode.state === "failed" &&
      (dialogWikiAttempt.state === "failed" || dialogWikiAttempt.state === "interrupted") &&
      dialogWikiAttempt.nodeGeneration === dialogNode.generation,
  );

  const canRerunDialog = Boolean(
    dialogNode &&
      dialogNode.state !== "cancelled" &&
      dialogNode.state !== "blocked" &&
      runId != null,
  );

  return {
    dialogNodeKey,
    dialogAttemptId,
    dialogNode,
    dialogWikiAttempt,
    dialogAttempt,
    dialogLabel,
    relatedAttempts,
    submitting,
    commandError,
    canRetryDialog,
    canRerunDialog,
    openNode,
    setDialogAttemptId,
    closeDialog,
    clearCommandError,
    retryFailed,
    rerunNode,
    dispatchCommand,
  };
}
