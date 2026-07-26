/**
 * Read-only layered Run Graph canvas (CSS grid — no xyflow).
 * Pure presentation of view-model from contract snapshot.
 */

import type { RunGraphSnapshot } from "@okf-wiki/contract";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { StatusBadge } from "../components/StatusBadge";
import {
  type RunGraphLayerId,
  type RunGraphViewEdge,
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
  /**
   * Transcript embed: chips only (no edge list / playhead scroll stack).
   * Edges remain on the view-model for tests; compact UI hides the list.
   */
  compact?: boolean;
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

function edgeStatusClass(status: RunGraphViewNode["status"] | undefined): string {
  switch (status) {
    case "running":
    case "awaiting":
      return "border-primary/40 text-foreground";
    case "done":
      return "border-border/60 text-muted-foreground";
    case "error":
    case "cancelled":
      return "border-destructive/40 text-destructive";
    default:
      return "border-border/40 text-muted-foreground";
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

/** Compact edge row under layers (no wall of SVG + duplicate list). */
function RunGraphEdges({
  edges,
  nodesByKey,
}: {
  edges: RunGraphViewEdge[];
  nodesByKey: Map<string, RunGraphViewNode>;
}) {
  if (edges.length === 0) return null;

  return (
    <ul
      className="flex max-h-28 flex-col gap-0.5 overflow-y-auto border-t border-border/50 pt-1.5"
      data-testid="run-graph-edges"
    >
      {edges.map((edge) => {
        const toNode = nodesByKey.get(edge.to);
        const fromNode = nodesByKey.get(edge.from);
        const status = toNode?.status ?? fromNode?.status;
        const fromLabel = fromNode?.label ?? edge.from;
        const toLabel = toNode?.label ?? edge.to;
        return (
          <li
            key={edge.id}
            className={`truncate rounded border px-1.5 py-0.5 text-2xs leading-snug ${edgeStatusClass(status)}`}
            data-testid="run-graph-edge"
            data-edge-id={edge.id}
            data-edge-kind={edge.kind}
            data-edge-from={edge.from}
            data-edge-to={edge.to}
            title={`${edge.from} → ${edge.to}`}
          >
            <span className="text-muted-foreground">{edge.kind}</span>{" "}
            <span className="font-medium">{fromLabel}</span>
            <span className="mx-0.5 text-muted-foreground" aria-hidden>
              →
            </span>
            <span className="font-medium">{toLabel}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function RunGraphCanvas({
  graph,
  className,
  selectedNodeKey,
  onSelectNode,
  compact = false,
}: RunGraphCanvasProps) {
  const { t } = useI18n();
  const vm = useMemo(() => runGraphToViewModel(graph), [graph]);
  const nodesByKey = useMemo(() => {
    const map = new Map<string, RunGraphViewNode>();
    for (const layer of vm.layers) {
      for (const node of layer.nodes) map.set(node.nodeKey, node);
    }
    return map;
  }, [vm.layers]);

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
      data-compact={compact ? "true" : undefined}
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
                const interactive = Boolean(onSelectNode);
                return (
                  <button
                    key={node.nodeKey}
                    type="button"
                    className={cn(
                      "flex min-w-0 items-center justify-between gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs leading-snug",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      statusClass(node.status),
                      selected && "ring-1 ring-primary/60",
                      interactive ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                    )}
                    data-testid="run-graph-node"
                    data-node-key={node.nodeKey}
                    data-node-status={node.status}
                    data-node-kind={node.kind}
                    data-selected={selected ? "true" : undefined}
                    onClick={() => onSelectNode?.(node.nodeKey)}
                    disabled={!interactive}
                    title={node.label}
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
      {/* Compact embed: keep edge test hooks without a scrolling wall under chips. */}
      {compact ? (
        vm.edges.length > 0 ? (
          <div className="sr-only" data-testid="run-graph-edges" aria-hidden>
            {vm.edges.map((edge) => (
              <span
                key={edge.id}
                data-testid="run-graph-edge"
                data-edge-id={edge.id}
                data-edge-kind={edge.kind}
                data-edge-from={edge.from}
                data-edge-to={edge.to}
              />
            ))}
          </div>
        ) : null
      ) : (
        <RunGraphEdges edges={vm.edges} nodesByKey={nodesByKey} />
      )}
      {!compact && vm.playhead ? (
        <p className="font-mono text-2xs text-muted-foreground" data-testid="run-graph-playhead">
          {t.agentWorkspace.runGraphPlayhead}: {vm.playhead.nodeKey}
        </p>
      ) : null}
    </div>
  );
}
