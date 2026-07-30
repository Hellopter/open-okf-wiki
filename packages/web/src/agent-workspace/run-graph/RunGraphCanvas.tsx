/**
 * Read-only Workflow view for a projected WikiRun snapshot.
 *
 * The control plane exposes parentKey, not a generic dependency graph. This
 * view therefore renders only that hierarchy and deliberately leaves every
 * other relationship absent.
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
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { StatusBadge } from "../components/StatusBadge";
import {
  type RunGraphLayerId,
  type RunGraphViewModel,
  type RunGraphViewNode,
} from "./view-model";

export type RunGraphCanvasProps = {
  /** Pre-projected layered view (e.g. wikiRunToViewModel). */
  viewModel: RunGraphViewModel;
  className?: string;
  /** Currently selected nodeKey (highlight). */
  selectedNodeKey?: string | null;
  /** Click a node — parent should open an Attempt inspector. */
  onSelectNode?: (nodeKey: string) => void;
};

type WorkflowBranch = {
  node: RunGraphViewNode;
  children: WorkflowBranch[];
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

function branchesFor(nodes: readonly RunGraphViewNode[]): WorkflowBranch[] {
  const childrenByParent = new Map<string, RunGraphViewNode[]>();
  const known = new Set(nodes.map((node) => node.nodeKey));

  for (const node of nodes) {
    if (!node.parentKey || !known.has(node.parentKey)) continue;
    const children = childrenByParent.get(node.parentKey) ?? [];
    children.push(node);
    childrenByParent.set(node.parentKey, children);
  }

  const branchFor = (node: RunGraphViewNode, ancestors: ReadonlySet<string>): WorkflowBranch => {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.nodeKey);
    const children = (childrenByParent.get(node.nodeKey) ?? [])
      .filter((child) => !nextAncestors.has(child.nodeKey))
      .map((child) => branchFor(child, nextAncestors));
    return { node, children };
  };

  const roots = nodes.filter((node) => !node.parentKey || !known.has(node.parentKey));
  // A malformed cycle has no root. Show flat nodes rather than silently
  // losing control-plane state or rendering the same node multiple times.
  if (roots.length === 0) return nodes.map((node) => ({ node, children: [] }));
  return roots.map((node) => branchFor(node, new Set()));
}

type WorkflowNodeProps = {
  branch: WorkflowBranch;
  selectedNodeKey?: string | null;
  playheadKey?: string;
  onSelectNode?: (nodeKey: string) => void;
  level: number;
};

function WorkflowNode({
  branch,
  selectedNodeKey,
  playheadKey,
  onSelectNode,
  level,
}: WorkflowNodeProps) {
  const { node, children } = branch;
  const selected = selectedNodeKey === node.nodeKey;
  const atPlayhead = playheadKey === node.nodeKey;
  const interactive = Boolean(onSelectNode);
  const active = atPlayhead && (node.status === "running" || node.status === "awaiting");

  return (
    <div className="relative min-w-0" data-testid="run-graph-branch">
      <Item
        render={<button type="button" />}
        role="treeitem"
        aria-level={level}
        aria-expanded={children.length > 0 ? true : undefined}
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
        data-parent-key={node.parentKey}
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

      {children.length > 0 ? (
        <ItemGroup
          role="group"
          className="mt-1.5 ml-3 gap-1.5 border-s border-border ps-3"
          data-testid="run-graph-children"
        >
          {children.map((child) => (
            <WorkflowNode
              key={child.node.nodeKey}
              branch={child}
              selectedNodeKey={selectedNodeKey}
              playheadKey={playheadKey}
              onSelectNode={onSelectNode}
              level={level + 1}
            />
          ))}
        </ItemGroup>
      ) : null}
    </div>
  );
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

  const branches = branchesFor(nodes);
  const branchesByLayer = new Map<RunGraphLayerId, WorkflowBranch[]>();
  for (const branch of branches) {
    const layer = branch.node.layer;
    const existing = branchesByLayer.get(layer) ?? [];
    existing.push(branch);
    branchesByLayer.set(layer, existing);
  }

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-3", className)}
      data-testid="run-graph-canvas"
      data-topology-version={viewModel.topologyVersion}
      data-edge-count={viewModel.edges.length}
      data-playhead-node={viewModel.playhead?.nodeKey}
      data-playhead-attempt={viewModel.playhead?.attemptId}
    >
      {[...branchesByLayer.entries()].map(([layer, layerBranches]) => (
        <section key={layer} className="flex min-w-0 flex-col gap-1.5">
          <p className="okf-section-label">{layerLabel(layer, t)}</p>
          <ItemGroup
            role="tree"
            aria-label={layerLabel(layer, t)}
            className="gap-1.5"
            data-testid="run-graph-layer"
            data-layer={layer}
          >
            {layerBranches.map((branch) => (
              <WorkflowNode
                key={branch.node.nodeKey}
                branch={branch}
                selectedNodeKey={selectedNodeKey}
                playheadKey={viewModel.playhead?.nodeKey}
                onSelectNode={onSelectNode}
                level={1}
              />
            ))}
          </ItemGroup>
        </section>
      ))}
    </div>
  );
}
