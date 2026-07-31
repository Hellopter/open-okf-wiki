/**
 * Read-only Workflow view for a projected WikiRun snapshot.
 *
 * The control plane exposes the directed dependency DAG. A node is rendered
 * once in its execution layer; incoming edges remain visible beside it rather
 * than being collapsed into a misleading parent-child tree.
 */

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  LoaderCircleIcon,
} from "lucide-react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { StatusBadge } from "../components/StatusBadge";
import { type RunGraphLayerId, type RunGraphViewModel, type RunGraphViewNode } from "./view-model";

export type RunGraphCanvasProps = {
  /** Pre-projected layered view (e.g. wikiRunToViewModel). */
  viewModel: RunGraphViewModel;
  className?: string;
  /** Currently selected nodeKey (highlight). */
  selectedNodeKey?: string | null;
  /** Click a node — parent should open an Attempt inspector. */
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

function NodeStatusIcon({ status }: { status: RunGraphViewNode["status"] }) {
  switch (status) {
    case "running":
    case "awaiting":
      return <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden />;
    case "done":
      return <CircleCheckIcon aria-hidden />;
    case "error":
    case "cancelled":
      return <CircleAlertIcon aria-hidden />;
    case "pending":
    case "skipped":
      return <CircleDashedIcon aria-hidden />;
    case "idle":
    default:
      return <CircleIcon aria-hidden />;
  }
}

type WorkflowNodeProps = {
  node: RunGraphViewNode;
  dependencies: string[];
  selectedNodeKey?: string | null;
  playheadKey?: string;
  onSelectNode?: (nodeKey: string) => void;
};

function WorkflowNode({
  node,
  dependencies,
  selectedNodeKey,
  playheadKey,
  onSelectNode,
}: WorkflowNodeProps) {
  const { t } = useI18n();
  const selected = selectedNodeKey === node.nodeKey;
  const atPlayhead = playheadKey === node.nodeKey;
  const interactive = Boolean(onSelectNode);
  const active = atPlayhead && (node.status === "running" || node.status === "awaiting");

  return (
    <div className="relative min-w-0" data-testid="run-graph-node-wrap">
      <Item
        render={<button type="button" />}
        role="listitem"
        aria-current={selected ? "true" : undefined}
        aria-disabled={!interactive || undefined}
        tabIndex={interactive ? 0 : -1}
        onClick={() => onSelectNode?.(node.nodeKey)}
        className={cn(
          "min-w-0 text-left",
          statusClass(node.status),
          selected && "ring-1 ring-primary/60",
          atPlayhead && !selected && "ring-2 ring-primary/35",
          active && "motion-safe:animate-pulse",
          interactive ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
        )}
        data-testid="run-graph-node"
        data-node-key={node.nodeKey}
        data-node-status={node.status}
        data-node-kind={node.kind}
        data-dependencies={dependencies.join(",") || undefined}
        data-selected={selected ? "true" : undefined}
        data-playhead={atPlayhead ? "true" : undefined}
      >
        <ItemMedia variant="icon" className="text-muted-foreground">
          <NodeStatusIcon status={node.status} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{node.label}</ItemTitle>
          <ItemDescription className="font-mono text-2xs">{node.nodeKey}</ItemDescription>
        </ItemContent>
        <ItemActions>
          {node.attemptCount > 1 ? (
            <span className="text-2xs tabular-nums text-muted-foreground">{node.attemptCount}</span>
          ) : null}
          <StatusBadge status={node.status} />
        </ItemActions>
      </Item>
      <p className="mt-1 ms-9 min-w-0 break-words text-2xs text-muted-foreground">
        <span className="me-1 uppercase tracking-wide">
          {t.agentWorkspace.runGraphDependencies}
        </span>
        <span className="font-mono">
          {dependencies.length ? dependencies.join(" · ") : t.agentWorkspace.runGraphNoDependencies}
        </span>
      </p>
    </div>
  );
}

function incomingDependencies(
  nodes: readonly RunGraphViewNode[],
  edges: RunGraphViewModel["edges"],
): Map<string, string[]> {
  const labels = new Map(nodes.map((node) => [node.nodeKey, node.label]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const from = labels.get(edge.from);
    if (!from || !labels.has(edge.to)) continue;
    const dependencies = incoming.get(edge.to) ?? [];
    dependencies.push(from);
    incoming.set(edge.to, dependencies);
  }
  return incoming;
}

export function RunGraphCanvas({
  viewModel: viewModel,
  className,
  selectedNodeKey,
  onSelectNode,
}: RunGraphCanvasProps) {
  const { t } = useI18n();
  const nodes = viewModel.layers.flatMap((layer) => layer.nodes);

  if (nodes.length === 0 && viewModel.attempts.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground" data-testid="run-graph-empty">
        {t.agentWorkspace.runGraphEmpty}
      </p>
    );
  }

  const dependenciesByNode = incomingDependencies(nodes, viewModel.edges);

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-3", className)}
      data-testid="run-graph-canvas"
      data-topology-version={viewModel.topologyVersion}
      data-edge-count={viewModel.edges.length}
      data-playhead-node={viewModel.playhead?.nodeKey}
      data-playhead-attempt={viewModel.playhead?.attemptId}
    >
      {viewModel.layers.map(({ id: layer, nodes: layerNodes }) => (
        <section key={layer} className="flex min-w-0 flex-col gap-1.5">
          <p className="okf-section-label">{layerLabel(layer, t)}</p>
          <div
            role="list"
            aria-label={layerLabel(layer, t)}
            className="flex min-w-0 flex-col gap-1.5"
            data-testid="run-graph-layer"
            data-layer={layer}
          >
            {layerNodes.map((node) => (
              <WorkflowNode
                key={node.nodeKey}
                node={node}
                dependencies={dependenciesByNode.get(node.nodeKey) ?? []}
                selectedNodeKey={selectedNodeKey}
                playheadKey={viewModel.playhead?.nodeKey}
                onSelectNode={onSelectNode}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
