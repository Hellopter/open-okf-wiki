/**
 * Read-only layered Run Graph canvas (CSS grid — no xyflow).
 * Pure presentation of view-model from contract snapshot.
 *
 * Topology edges stay on the view-model for tests / future drawing; this canvas
 * does not dump them as a redundant text list. Contract `playhead` is a journal
 * cursor (latest upserted attempt) and is shown as a chip highlight, not AV chrome.
 */

import type { RunGraphSnapshot } from "@okf-wiki/contract";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { StatusBadge } from "../components/StatusBadge";
import {
  type RunGraphLayerId,
  type RunGraphViewNode,
  runGraphToViewModel,
} from "./view-model";

export type RunGraphCanvasProps = {
  graph: RunGraphSnapshot;
  className?: string;
  /** Currently selected nodeKey (highlight). */
  selectedNodeKey?: string | null;
  /** Click a node — parent should open a dialog, not expand inline. */
  onSelectNode?: (nodeKey: string) => void;
};

function statusClass(status: RunGraphViewNode["status"]): string {
  switch (status) {
    case "running":
    case "awaiting":
      return "border-primary/50 bg-primary/10 text-foreground";
    case "done":
      return "border-border/70 bg-background/60 text-foreground";
    case "error":
    case "cancelled":
      return "border-destructive/40 bg-destructive/10 text-foreground";
    case "skipped":
    case "pending":
    case "idle":
    default:
      return "border-border/50 bg-muted/30 text-muted-foreground";
  }
}

function layerLabel(id: RunGraphLayerId, t: ReturnType<typeof useI18n>["t"]): string {
  const labels = t.agentWorkspace.runGraphLayers;
  switch (id) {
    case "plan":
      return labels.plan;
    case "research":
      return labels.research;
    case "write":
      return labels.write;
    case "review":
      return labels.review;
    case "repair":
      return labels.repair;
    case "validate":
      return labels.validate;
    case "publish":
      return labels.publish;
    default:
      return labels.other;
  }
}

function nodeTitle(node: RunGraphViewNode): string {
  if (node.parentKey) return `${node.label} ← ${node.parentKey}`;
  return node.label;
}

export function RunGraphCanvas({
  graph,
  className,
  selectedNodeKey,
  onSelectNode,
}: RunGraphCanvasProps) {
  const { t } = useI18n();
  const vm = useMemo(() => runGraphToViewModel(graph), [graph]);
  const playheadKey = vm.playhead?.nodeKey;

  if (vm.layers.length === 0 && vm.attempts.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground" data-testid="run-graph-empty">
        {t.agentWorkspace.runGraphEmpty}
      </p>
    );
  }

  return (
    <div
      className={className ?? "flex flex-col gap-2"}
      data-testid="run-graph-canvas"
      data-topology-version={vm.topologyVersion}
      data-playhead-node={playheadKey}
      data-playhead-attempt={vm.playhead?.attemptId}
    >
      <div className="flex flex-col gap-2">
        {vm.layers.map((layer) => (
          <div
            key={layer.id}
            className="flex flex-col gap-1"
            data-testid="run-graph-layer"
            data-layer={layer.id}
          >
            <p className="okf-section-label">{layerLabel(layer.id, t)}</p>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {layer.nodes.map((node) => {
                const selected = selectedNodeKey === node.nodeKey;
                const atPlayhead = playheadKey === node.nodeKey;
                const interactive = Boolean(onSelectNode);
                const active =
                  atPlayhead && (node.status === "running" || node.status === "awaiting");
                return (
                  <button
                    key={node.nodeKey}
                    type="button"
                    className={cn(
                      "flex min-w-0 items-center justify-between gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs leading-snug",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      statusClass(node.status),
                      selected && "ring-1 ring-primary/60",
                      atPlayhead && !selected && "ring-2 ring-primary/35",
                      active && "animate-pulse",
                      interactive ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                    )}
                    data-testid="run-graph-node"
                    data-node-key={node.nodeKey}
                    data-node-status={node.status}
                    data-node-kind={node.kind}
                    data-selected={selected ? "true" : undefined}
                    data-playhead={atPlayhead ? "true" : undefined}
                    onClick={() => onSelectNode?.(node.nodeKey)}
                    disabled={!interactive}
                    title={nodeTitle(node)}
                  >
                    <span className="min-w-0 truncate font-medium">{node.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {node.attemptCount > 1 ? (
                        <span className="text-2xs text-muted-foreground">×{node.attemptCount}</span>
                      ) : null}
                      <StatusBadge status={node.status} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
