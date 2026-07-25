/**
 * Read-only layered Run Graph canvas (CSS grid — no xyflow).
 * Pure presentation of view-model from contract snapshot.
 */

import type { RunGraphSnapshot } from "@okf-wiki/contract";
import { useMemo } from "react";
import { useI18n } from "../../i18n";
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
  /** Click a node to select its latest attempt. */
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

function layerLabel(
  id: RunGraphLayerId,
  t: ReturnType<typeof useI18n>["t"],
): string {
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

export function RunGraphCanvas({
  graph,
  className,
  selectedNodeKey,
  onSelectNode,
}: RunGraphCanvasProps) {
  const { t } = useI18n();
  const vm = useMemo(() => runGraphToViewModel(graph), [graph]);

  if (vm.layers.length === 0 && vm.attempts.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="run-graph-empty">
        {t.agentWorkspace.runGraphEmpty}
      </p>
    );
  }

  return (
    <div
      className={className ?? "space-y-2"}
      data-testid="run-graph-canvas"
      data-topology-version={vm.topologyVersion}
    >
      <div className="flex flex-col gap-2">
        {vm.layers.map((layer) => (
          <div
            key={layer.id}
            className="space-y-1"
            data-testid="run-graph-layer"
            data-layer={layer.id}
          >
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {layerLabel(layer.id, t)}
            </p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {layer.nodes.map((node) => {
                const selected = selectedNodeKey === node.nodeKey;
                const interactive = Boolean(onSelectNode);
                return (
                  <button
                    key={node.nodeKey}
                    type="button"
                    className={`rounded border px-1.5 py-1 text-left font-mono text-[10px] leading-snug ${statusClass(node.status)} ${
                      selected ? "ring-1 ring-primary/60" : ""
                    } ${interactive ? "cursor-pointer hover:bg-muted/40" : "cursor-default"}`}
                    data-testid="run-graph-node"
                    data-node-key={node.nodeKey}
                    data-node-status={node.status}
                    data-node-kind={node.kind}
                    data-selected={selected ? "true" : undefined}
                    onClick={() => onSelectNode?.(node.nodeKey)}
                    disabled={!interactive}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate font-medium">{node.label}</span>
                      {node.attemptCount > 1 ? (
                        <span className="shrink-0 text-muted-foreground">×{node.attemptCount}</span>
                      ) : null}
                    </div>
                    <div className="truncate text-muted-foreground">
                      {node.latestAttempt?.summary ?? node.status}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {vm.playhead ? (
        <p className="font-mono text-[10px] text-muted-foreground" data-testid="run-graph-playhead">
          {t.agentWorkspace.runGraphPlayhead}: {vm.playhead.nodeKey}
        </p>
      ) : null}
    </div>
  );
}
