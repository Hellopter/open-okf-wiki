import type { WikiRunNode, WikiRunSnapshot } from "@okf-wiki/contract";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  PlayIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { describeNodeStatus } from "@/components/agent-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMessage, type MessageTree } from "../i18n";
import {
  buildFocusTopology,
  buildWorkflowStages,
  type FocusTopology,
  projectCollapsedResearchLeaves,
  researchDomainLeafGroups,
  shouldCollapseResearchLeaves,
  type WorkflowEdgeRelation,
  type WorkflowStage,
  type WorkflowStageId,
} from "./workflow-topology";

/**
 * Layout + chrome follow React Flow / ELK guidance:
 * - measure (or fix) node size for ELK; spacing ≫ defaults
 * - multi-handles + port order for fan-out/join (elkjs-multiple-handles)
 * - edge stroke beats background; marker color matches stroke
 * - assign handles by laid-out Y so orthogonal edges stay parallel, not center-bundled
 * @see https://reactflow.dev/examples/layout/elkjs
 * @see https://reactflow.dev/examples/layout/elkjs-multiple-handles
 */
const FOCUS_NODE_WIDTH = 220;
const FOCUS_NODE_HEIGHT = 72;
const PORT_SLOT = 20;
const OVERVIEW_NODE_WIDTH = 216;
const OVERVIEW_NODE_GAP = 64;
const OVERVIEW_STEP_X = OVERVIEW_NODE_WIDTH + OVERVIEW_NODE_GAP;

/** xyflow-ish gray — visible on light/dark; never near-white --border. */
const EDGE_STROKE = "#8b8b93";
const EDGE_STROKE_MUTED = "#a8a8b0";
const EDGE_STROKE_CONTROL = "#6b6b74";
const EDGE_WIDTH = 1.75;
const EDGE_WIDTH_FAN = 1.35;

type OverviewNodeData = {
  stage: WorkflowStage;
  stateLabel: string;
  /** Bottom handles only when quality→synthesis feedback is present. */
  showFeedbackHandles: boolean;
};
type DomainCollapseUi = {
  leafCount: number;
  expanded: boolean;
  leafCountLabel: string;
  toggleLabel: string;
  onToggle: () => void;
};

type FocusNodeData = {
  node: WikiRunNode;
  displayLabel: string;
  stateLabel: string;
  selected: boolean;
  context: boolean;
  sourceHandleIds: string[];
  targetHandleIds: string[];
  domainCollapse?: DomainCollapseUi;
};
type OverviewNode = Node<OverviewNodeData, "overview">;
type FocusNode = Node<FocusNodeData, "focus">;

type TopologyEdge = FocusTopology["edges"][number];

type HandlePlan = {
  sourceHandleByEdge: Map<string, string>;
  targetHandleByEdge: Map<string, string>;
  sourceHandleIdsByNode: Map<string, string[]>;
  targetHandleIdsByNode: Map<string, string[]>;
  heightByNode: Map<string, number>;
};

function stateClass(state: string): string {
  return describeNodeStatus(state).surfaceClass;
}

function handleClassName(dense: boolean): string {
  return dense
    ? "!size-1.5 !border-0 !bg-muted-foreground/35"
    : "!size-2 !border !border-border !bg-muted-foreground/50";
}

function handleTopPercent(index: number, total: number): string {
  if (total <= 1) return "50%";
  return `${((index + 1) / (total + 1)) * 100}%`;
}

function baseNodeHeight(node: WikiRunNode): number {
  return node.generation > 0 ? FOCUS_NODE_HEIGHT + 14 : FOCUS_NODE_HEIGHT;
}

function degreeHeight(node: WikiRunNode, degree: number): number {
  const base = baseNodeHeight(node);
  if (degree <= 2) return base;
  // Room for one port slot per incident edge so multi-handles do not stack.
  return Math.max(base, degree * PORT_SLOT + 28);
}

function OverviewCard({ data }: NodeProps<OverviewNode>) {
  return (
    <div
      className={`flex h-[4.75rem] w-[216px] flex-col justify-between rounded-lg border px-3.5 py-3 shadow-sm ${stateClass(data.stage.state)}`}
    >
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className={handleClassName(false)}
      />
      {data.showFeedbackHandles && data.stage.id === "synthesis" ? (
        <Handle
          id="bottom"
          type="target"
          position={Position.Bottom}
          className={handleClassName(false)}
        />
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={data.stage.label}>
          {data.stage.label}
        </p>
        <Badge variant="outline" className="shrink-0">
          {data.stateLabel}
        </Badge>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {data.stage.completed}/{data.stage.total}
      </p>
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className={handleClassName(false)}
      />
      {data.showFeedbackHandles && data.stage.id === "quality" ? (
        <Handle
          id="bottom-source"
          type="source"
          position={Position.Bottom}
          className={handleClassName(false)}
        />
      ) : null}
    </div>
  );
}

function FocusCard({ data }: NodeProps<FocusNode>) {
  const { node } = data;
  const sources = data.sourceHandleIds;
  const targets = data.targetHandleIds;
  const dense = Math.max(sources.length, targets.length) > 3;
  const domain = data.domainCollapse;
  return (
    <div
      title={data.displayLabel}
      className={`relative flex h-full w-full flex-col justify-center rounded-lg border px-3 py-2.5 shadow-sm transition-shadow ${
        data.context
          ? "border-dashed border-muted-foreground/40 bg-muted/40 opacity-90"
          : stateClass(node.state)
      } ${data.selected ? "ring-2 ring-primary/45 ring-offset-1 ring-offset-background" : "hover:shadow-md"}`}
    >
      {targets.map((id, index) => (
        <Handle
          key={id}
          id={id}
          type="target"
          position={Position.Left}
          className={handleClassName(dense)}
          style={{ top: handleTopPercent(index, targets.length) }}
        />
      ))}
      <div className="flex min-w-0 items-start gap-1.5">
        {node.state === "running" ? (
          <PlayIcon className="mt-0.5 size-3 shrink-0 text-primary" />
        ) : node.state === "failed" ? (
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
        ) : null}
        <p className="line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug">
          {data.displayLabel}
        </p>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {node.kind}
        </span>
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
          {data.stateLabel}
        </Badge>
      </div>
      {domain ? (
        <button
          type="button"
          className="nodrag nopan mt-2 flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-expanded={domain.expanded}
          aria-label={domain.toggleLabel}
          title={domain.toggleLabel}
          onClick={(event) => {
            event.stopPropagation();
            domain.onToggle();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="inline-flex min-w-0 items-center gap-1">
            {domain.expanded ? (
              <ChevronDownIcon className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0" />
            )}
            <span className="truncate">{domain.leafCountLabel}</span>
          </span>
          <span className="shrink-0 text-[10px] font-medium text-foreground/70">
            {domain.expanded ? "−" : "+"}
          </span>
        </button>
      ) : null}
      {node.generation > 0 ? (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">#{node.generation}</p>
      ) : null}
      {sources.map((id, index) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={Position.Right}
          className={handleClassName(dense)}
          style={{ top: handleTopPercent(index, sources.length) }}
        />
      ))}
    </div>
  );
}

const nodeTypes = { overview: OverviewCard, focus: FocusCard };

function stateLabel(state: string, t: MessageTree): string {
  return (
    t.workbench.nodeStates[state as keyof typeof t.workbench.nodeStates] ??
    state.replaceAll("_", " ")
  );
}

function nodeLabel(node: WikiRunNode, t: MessageTree): string {
  if (node.kind === "plan.adapt" && /^\d+$/.test(node.label.trim())) return t.workbench.planAdapt;
  return node.label.trim() || node.key;
}

function arrowMarker(color: string): Edge["markerEnd"] {
  return {
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color,
  };
}

function edgeStyle(
  relation: WorkflowEdgeRelation,
  t: MessageTree,
): Pick<
  Edge,
  | "style"
  | "label"
  | "labelStyle"
  | "labelBgStyle"
  | "labelBgPadding"
  | "labelShowBg"
  | "animated"
  | "markerEnd"
  | "zIndex"
> {
  if (relation === "feedback") {
    return {
      animated: true,
      zIndex: 3,
      label: t.workbench.recheck,
      labelShowBg: true,
      labelBgPadding: [4, 6],
      labelBgStyle: { fill: "var(--background)", fillOpacity: 0.92 },
      labelStyle: { fontSize: 11, fill: "var(--primary)", fontWeight: 500 },
      style: { stroke: "var(--primary)", strokeWidth: 2 },
      markerEnd: arrowMarker("var(--primary)"),
    };
  }
  if (relation === "control") {
    return {
      zIndex: 2,
      label: t.workbench.controlEdge,
      labelShowBg: true,
      labelBgPadding: [3, 5],
      labelBgStyle: { fill: "var(--background)", fillOpacity: 0.92 },
      labelStyle: { fontSize: 10, fill: EDGE_STROKE_CONTROL },
      style: {
        strokeDasharray: "5 4",
        stroke: EDGE_STROKE_CONTROL,
        strokeWidth: EDGE_WIDTH,
      },
      markerEnd: arrowMarker(EDGE_STROKE_CONTROL),
    };
  }
  if (relation === "fanout" || relation === "join") {
    return {
      zIndex: 0,
      style: { stroke: EDGE_STROKE_MUTED, strokeWidth: EDGE_WIDTH_FAN },
      markerEnd: arrowMarker(EDGE_STROKE_MUTED),
    };
  }
  return {
    zIndex: 1,
    style: { stroke: EDGE_STROKE, strokeWidth: EDGE_WIDTH },
    markerEnd: arrowMarker(EDGE_STROKE),
  };
}

/** Kind rank keeps model order ≈ left-to-right pipeline for ELK. */
function kindRank(kind: string): number {
  if (kind === "freeze" || kind === "plan" || kind === "gate.plan") return 0;
  if (kind === "research.leaf") return 1;
  if (kind === "research.domain") return 2;
  if (kind === "plan.adapt") return 3;
  if (kind === "write.root" || kind === "validate.pre") return 4;
  if (kind === "review.seat" || kind === "review.reduce") return 5;
  if (kind === "gate.fix" || kind === "repair" || kind === "validate.final") return 6;
  return 7;
}

function orderedTopologyNodes(nodes: WikiRunNode[]): WikiRunNode[] {
  return [...nodes].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.key.localeCompare(b.key),
  );
}

function degreeMaps(edges: TopologyEdge[]): {
  outDegree: Map<string, number>;
  inDegree: Map<string, number>;
} {
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  return { outDegree, inDegree };
}

/**
 * Drop length-2 transitive forward edges for display (A→C when A→B→C exists).
 * Keeps the real control-plane snapshot intact; only the React Flow projection
 * simplifies so domain→write does not pile on top of domain→adapt→write.
 */
function simplifyDisplayEdges(edges: TopologyEdge[]): TopologyEdge[] {
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = adj.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    adj.set(edge.source, targets);
  }
  return edges.filter((edge) => {
    if (edge.relation === "feedback" || edge.relation === "control") return true;
    for (const mid of adj.get(edge.source) ?? []) {
      if (mid === edge.target) continue;
      if (adj.get(mid)?.has(edge.target)) return false;
    }
    return true;
  });
}

/**
 * After ELK places nodes, bind each edge to a dedicated handle ordered by the
 * counterpart's Y. That turns center-bundled fan-out into parallel orthogonal runs
 * (React Flow multi-handle + ELK model-order pattern).
 */
function buildHandlePlan(
  topology: FocusTopology,
  positions: Record<string, { x: number; y: number }>,
): HandlePlan {
  const { outDegree, inDegree } = degreeMaps(topology.edges);
  const heightByNode = new Map<string, number>();
  for (const node of topology.nodes) {
    const degree = Math.max(outDegree.get(node.key) ?? 0, inDegree.get(node.key) ?? 0, 1);
    heightByNode.set(node.key, degreeHeight(node, degree));
  }

  const bySource = new Map<string, TopologyEdge[]>();
  const byTarget = new Map<string, TopologyEdge[]>();
  for (const edge of topology.edges) {
    const outs = bySource.get(edge.source) ?? [];
    outs.push(edge);
    bySource.set(edge.source, outs);
    const ins = byTarget.get(edge.target) ?? [];
    ins.push(edge);
    byTarget.set(edge.target, ins);
  }

  const yOf = (key: string) => positions[key]?.y ?? 0;

  const sourceHandleByEdge = new Map<string, string>();
  const targetHandleByEdge = new Map<string, string>();
  const sourceHandleIdsByNode = new Map<string, string[]>();
  const targetHandleIdsByNode = new Map<string, string[]>();

  for (const node of topology.nodes) {
    const outs = [...(bySource.get(node.key) ?? [])].sort(
      (a, b) => yOf(a.target) - yOf(b.target) || a.target.localeCompare(b.target),
    );
    const ins = [...(byTarget.get(node.key) ?? [])].sort(
      (a, b) => yOf(a.source) - yOf(b.source) || a.source.localeCompare(b.source),
    );
    const sourceIds = outs.length > 0 ? outs.map((_, i) => `out-${i}`) : ["out-0"];
    const targetIds = ins.length > 0 ? ins.map((_, i) => `in-${i}`) : ["in-0"];
    sourceHandleIdsByNode.set(node.key, sourceIds);
    targetHandleIdsByNode.set(node.key, targetIds);
    outs.forEach((edge, i) => sourceHandleByEdge.set(edge.id, `out-${i}`));
    ins.forEach((edge, i) => targetHandleByEdge.set(edge.id, `in-${i}`));
  }

  return {
    sourceHandleByEdge,
    targetHandleByEdge,
    sourceHandleIdsByNode,
    targetHandleIdsByNode,
    heightByNode,
  };
}

function elkLayoutOptions(nodeCount: number): Record<string, string> {
  const dense = nodeCount > 10;
  return {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": dense ? "72" : "56",
    "elk.spacing.edgeNode": dense ? "32" : "24",
    "elk.spacing.edgeEdge": dense ? "18" : "14",
    "elk.spacing.portPort": "12",
    "elk.layered.spacing.nodeNodeBetweenLayers": dense ? "140" : "110",
    "elk.layered.spacing.edgeNodeBetweenLayers": "32",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.considerModelOrder.portModelOrder": "true",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.layered.nodePlacement.favorStraightEdges": "true",
    "elk.layered.unnecessaryBendpoints": "true",
  };
}

function focusGraphMinHeight(nodeCount: number): string {
  if (nodeCount > 16) return "min-h-[56rem]";
  if (nodeCount > 10) return "min-h-[48rem]";
  if (nodeCount > 6) return "min-h-[38rem]";
  return "min-h-[34rem]";
}

function FocusGraph({
  snapshot,
  stage,
  selectedNodeKey,
  onSelectNode,
  t,
}: {
  snapshot: WikiRunSnapshot;
  stage: WorkflowStageId;
  selectedNodeKey: string | null;
  onSelectNode: (nodeKey: string) => void;
  t: MessageTree;
}) {
  const baseTopology = useMemo(() => buildFocusTopology(snapshot, stage), [snapshot, stage]);
  const domainGroups = useMemo(
    () => researchDomainLeafGroups(baseTopology),
    [baseTopology],
  );
  const collapseEnabled = useMemo(
    () => shouldCollapseResearchLeaves(baseTopology),
    [baseTopology],
  );
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    // New stage / run topology resets domain expansion to the collapsed default.
    setExpandedDomains(new Set());
  }, [baseTopology.topologyKey]);

  const toggleDomain = useCallback((domainKey: string) => {
    setExpandedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domainKey)) next.delete(domainKey);
      else next.add(domainKey);
      return next;
    });
  }, []);

  const expandAllDomains = useCallback(() => {
    setExpandedDomains(new Set(domainGroups.keys()));
  }, [domainGroups]);

  const collapseAllDomains = useCallback(() => {
    setExpandedDomains(new Set());
  }, []);

  const topology = useMemo(
    () =>
      collapseEnabled
        ? projectCollapsedResearchLeaves(baseTopology, expandedDomains)
        : baseTopology,
    [baseTopology, collapseEnabled, expandedDomains],
  );

  const displayEdges = useMemo(
    () => simplifyDisplayEdges(topology.edges),
    [topology.edges],
  );
  const orderedNodes = useMemo(() => orderedTopologyNodes(topology.nodes), [topology.nodes]);
  const { outDegree, inDegree } = useMemo(() => degreeMaps(displayEdges), [displayEdges]);

  const layoutInput = useMemo(() => {
    // Pre-size high-degree nodes so ELK reserves vertical room for multi-handles.
    // Domain cards with collapse chrome need a little extra height.
    const children = orderedNodes.map((node) => {
      const degree = Math.max(outDegree.get(node.key) ?? 0, inDegree.get(node.key) ?? 0, 1);
      let height = degreeHeight(node, degree);
      if (collapseEnabled && node.kind === "research.domain" && domainGroups.has(node.key)) {
        height = Math.max(height, FOCUS_NODE_HEIGHT + 28);
      }
      const portCountOut = Math.max(outDegree.get(node.key) ?? 0, 1);
      const portCountIn = Math.max(inDegree.get(node.key) ?? 0, 1);
      const ports = [
        ...Array.from({ length: portCountIn }, (_, i) => ({
          id: `${node.key}:in-${i}`,
          width: 6,
          height: 6,
          layoutOptions: { "elk.port.side": "WEST", "elk.port.index": String(i) },
        })),
        ...Array.from({ length: portCountOut }, (_, i) => ({
          id: `${node.key}:out-${i}`,
          width: 6,
          height: 6,
          layoutOptions: { "elk.port.side": "EAST", "elk.port.index": String(i) },
        })),
      ];
      return {
        id: node.key,
        width: FOCUS_NODE_WIDTH,
        height,
        ports,
        layoutOptions: {
          "elk.portConstraints": "FIXED_ORDER",
        },
      };
    });

    const edges = [...displayEdges].sort((a, b) => {
      const sa = orderedNodes.findIndex((n) => n.key === a.source);
      const sb = orderedNodes.findIndex((n) => n.key === b.source);
      return sa - sb || a.target.localeCompare(b.target);
    });

    const outIndex = new Map<string, number>();
    const inIndex = new Map<string, number>();
    const elkEdges = edges.map((edge) => {
      const oi = outIndex.get(edge.source) ?? 0;
      outIndex.set(edge.source, oi + 1);
      const ii = inIndex.get(edge.target) ?? 0;
      inIndex.set(edge.target, ii + 1);
      return {
        id: edge.id,
        sources: [`${edge.source}:out-${oi}`],
        targets: [`${edge.target}:in-${ii}`],
      };
    });

    return { children, edges: elkEdges };
  }, [
    orderedNodes,
    displayEdges,
    outDegree,
    inDegree,
    collapseEnabled,
    domainGroups,
  ]);

  const topologyNodeCount = topology.nodes.length;
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    let active = true;
    setPositions({});
    const elk = new ELK();
    void elk
      .layout({
        id: "focus",
        layoutOptions: elkLayoutOptions(topologyNodeCount),
        ...layoutInput,
      })
      .then((layout) => {
        if (!active) return;
        setPositions(
          Object.fromEntries(
            (layout.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
          ),
        );
      });
    return () => {
      active = false;
    };
  }, [layoutInput, topologyNodeCount]);

  const handlePlan = useMemo(() => {
    if (Object.keys(positions).length !== topologyNodeCount) return null;
    const plan = buildHandlePlan({ ...topology, edges: displayEdges }, positions);
    // Match ELK height for domain collapse chrome.
    if (collapseEnabled) {
      for (const node of topology.nodes) {
        if (node.kind !== "research.domain" || !domainGroups.has(node.key)) continue;
        const current = plan.heightByNode.get(node.key) ?? baseNodeHeight(node);
        plan.heightByNode.set(node.key, Math.max(current, FOCUS_NODE_HEIGHT + 28));
      }
    }
    return plan;
  }, [positions, topology, displayEdges, topologyNodeCount, collapseEnabled, domainGroups]);

  useEffect(() => {
    if (!flow || !handlePlan || Object.keys(positions).length !== topologyNodeCount) return;
    const frame = requestAnimationFrame(() => {
      flow.fitView({
        padding: topologyNodeCount > 12 ? 0.08 : 0.14,
        minZoom: topologyNodeCount > 12 ? 0.42 : 0.55,
        maxZoom: 1.05,
        duration: 180,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, handlePlan, positions, topologyNodeCount, topology.topologyKey]);

  const nodes: FocusNode[] = useMemo(() => {
    const plan = handlePlan;
    return topology.nodes.map((node, index) => {
      const sourceHandleIds = plan?.sourceHandleIdsByNode.get(node.key) ?? ["out-0"];
      const targetHandleIds = plan?.targetHandleIdsByNode.get(node.key) ?? ["in-0"];
      const leafCount = domainGroups.get(node.key)?.length ?? 0;
      const domainCollapse: DomainCollapseUi | undefined =
        collapseEnabled && node.kind === "research.domain" && leafCount > 0
          ? {
              leafCount,
              expanded: expandedDomains.has(node.key),
              leafCountLabel: formatMessage(t.workbench.domainLeafCount, {
                count: leafCount,
              }),
              toggleLabel: expandedDomains.has(node.key)
                ? t.workbench.collapseDomain
                : t.workbench.expandDomain,
              onToggle: () => toggleDomain(node.key),
            }
          : undefined;
      return {
        id: node.key,
        type: "focus" as const,
        position: positions[node.key] ?? {
          x: (index % 4) * (FOCUS_NODE_WIDTH + 48),
          y: Math.floor(index / 4) * (FOCUS_NODE_HEIGHT + 40),
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: FOCUS_NODE_WIDTH,
          height: plan?.heightByNode.get(node.key) ?? baseNodeHeight(node),
        },
        data: {
          node,
          displayLabel: nodeLabel(node, t),
          stateLabel: stateLabel(node.state, t),
          selected: node.key === selectedNodeKey,
          context: topology.contextNodeKeys.has(node.key),
          sourceHandleIds,
          targetHandleIds,
          domainCollapse,
        },
      };
    });
  }, [
    topology.nodes,
    topology.contextNodeKeys,
    positions,
    handlePlan,
    selectedNodeKey,
    t,
    collapseEnabled,
    domainGroups,
    expandedDomains,
    toggleDomain,
  ]);

  const edges: Edge[] = useMemo(() => {
    const plan = handlePlan;
    return displayEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: plan?.sourceHandleByEdge.get(edge.id) ?? "out-0",
      targetHandle: plan?.targetHandleByEdge.get(edge.id) ?? "in-0",
      type: "smoothstep" as const,
      ...edgeStyle(edge.relation, t),
    }));
  }, [displayEdges, handlePlan, t]);

  if (baseTopology.nodes.length === 0)
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">{t.workbench.noStageNodes}</p>
    );

  const allExpanded =
    collapseEnabled &&
    domainGroups.size > 0 &&
    [...domainGroups.keys()].every((key) => expandedDomains.has(key));

  return (
    <div
      className={`hidden flex-1 flex-col md:flex ${focusGraphMinHeight(topology.nodes.length)}`}
      data-testid="run-focus-graph"
    >
      {collapseEnabled ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border/70 px-4 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={allExpanded ? collapseAllDomains : expandAllDomains}
            data-testid="run-focus-domain-toggle-all"
          >
            {allExpanded ? t.workbench.collapseAllDomains : t.workbench.expandAllDomains}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ReactFlow
          key={`${stage}:${topology.topologyKey}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setFlow}
          fitView
          fitViewOptions={{
            padding: 0.14,
            minZoom: 0.5,
            maxZoom: 1.05,
          }}
          minZoom={0.25}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          edgesFocusable={false}
          defaultEdgeOptions={{
            type: "smoothstep",
            style: { stroke: EDGE_STROKE, strokeWidth: EDGE_WIDTH },
            markerEnd: arrowMarker(EDGE_STROKE),
          }}
          onNodeClick={(_, node) => onSelectNode(node.id)}
          proOptions={{ hideAttribution: true }}
          className="bg-background"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={2}
            nodeBorderRadius={6}
            nodeColor={(node) => {
              const state = (node.data as FocusNodeData | undefined)?.node?.state;
              if (state === "running") return "var(--primary)";
              if (state === "failed") return "var(--destructive)";
              if (state === "succeeded") return "oklch(0.55 0.12 155)";
              if (state === "waiting") return "oklch(0.7 0.12 75)";
              return "var(--muted-foreground)";
            }}
            maskColor="color-mix(in oklch, var(--background) 72%, transparent)"
            className="!h-28 !w-40 !rounded-md !border !border-border/80 !bg-background/90 !shadow-sm"
          />
          <Controls showInteractive={false} className="!rounded-md !border-border !shadow-sm" />
        </ReactFlow>
      </div>
    </div>
  );
}

function MobileStageList({
  stages,
  stage,
  onFocus,
  onSelectNode,
  t,
}: {
  stages: WorkflowStage[];
  stage: WorkflowStageId | null;
  onFocus: (stage: WorkflowStageId) => void;
  onSelectNode: (nodeKey: string) => void;
  t: MessageTree;
}) {
  const focused = stage ? stages.find((item) => item.id === stage) : null;
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 md:hidden">
      {stages.map((item) => (
        <Button
          key={item.id}
          variant={item.id === stage ? "secondary" : "outline"}
          className="h-auto justify-between px-4 py-3 text-left"
          onClick={() => onFocus(item.id)}
        >
          <span>
            <span className="block text-sm font-medium">{item.label}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {item.completed}/{item.total}
            </span>
          </span>
          <Badge variant="outline">{stateLabel(item.state, t)}</Badge>
        </Button>
      ))}
      {focused ? (
        <div className="mt-2 divide-y divide-border border-y border-border">
          {focused.nodes.map((node) => (
            <Button
              key={node.key}
              variant="ghost"
              className="h-auto w-full justify-between px-2 py-3 text-left"
              onClick={() => onSelectNode(node.key)}
            >
              <span className="min-w-0 truncate text-sm">{nodeLabel(node, t)}</span>
              <Badge variant="outline">{stateLabel(node.state, t)}</Badge>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RunGraph({
  snapshot,
  selectedNodeKey,
  focusedStage,
  onFocusedStageChange,
  onSelectNode,
  t,
}: {
  snapshot: WikiRunSnapshot;
  selectedNodeKey: string | null;
  focusedStage: WorkflowStageId | null;
  onFocusedStageChange: (stage: WorkflowStageId | null) => void;
  onSelectNode: (nodeKey: string) => void;
  t: MessageTree;
}) {
  const stages = useMemo(
    () =>
      buildWorkflowStages(snapshot, {
        plan: t.workbench.stagePlan,
        research: t.workbench.stageResearch,
        synthesis: t.workbench.stageSynthesis,
        quality: t.workbench.stageQuality,
        publication: t.workbench.stagePublication,
      }),
    [
      snapshot,
      t.workbench.stagePlan,
      t.workbench.stageResearch,
      t.workbench.stageSynthesis,
      t.workbench.stageQuality,
      t.workbench.stagePublication,
    ],
  );
  const setFocusedStage = onFocusedStageChange;
  const hasFeedback = snapshot.edges.some(
    (edge) =>
      snapshot.nodes.find((node) => node.key === edge.from)?.kind === "repair" &&
      snapshot.nodes.find((node) => node.key === edge.to)?.kind === "validate.pre",
  );
  const overviewNodes: OverviewNode[] = stages.map((stage, index) => ({
    id: `stage:${stage.id}`,
    type: "overview",
    position: { x: index * OVERVIEW_STEP_X, y: 100 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      stage,
      stateLabel: stateLabel(stage.state, t),
      showFeedbackHandles: hasFeedback,
    },
  }));
  const overviewEdges: Edge[] = stages.slice(0, -1).map((stage, index) => ({
    id: `${stage.id}->${stages[index + 1]!.id}`,
    source: `stage:${stage.id}`,
    target: `stage:${stages[index + 1]!.id}`,
    sourceHandle: "right",
    targetHandle: "left",
    type: "straight",
    markerEnd: arrowMarker(EDGE_STROKE),
    style: { stroke: EDGE_STROKE, strokeWidth: EDGE_WIDTH },
  }));
  if (hasFeedback)
    overviewEdges.push({
      id: "quality-feedback",
      source: "stage:quality",
      target: "stage:synthesis",
      sourceHandle: "bottom-source",
      targetHandle: "bottom",
      type: "step",
      animated: true,
      markerEnd: arrowMarker("var(--primary)"),
      label: t.workbench.recheck,
      labelShowBg: true,
      labelBgPadding: [4, 6],
      labelBgStyle: { fill: "var(--background)", fillOpacity: 0.92 },
      labelStyle: { fontSize: 11, fill: "var(--primary)", fontWeight: 500 },
      style: { stroke: "var(--primary)", strokeWidth: 2 },
    });

  return (
    <div className="flex min-h-[34rem] flex-1 flex-col" data-testid="run-graph">
      {focusedStage ? (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
            <Button size="sm" variant="ghost" onClick={() => setFocusedStage(null)}>
              <ArrowLeftIcon data-icon="inline-start" />
              {t.workbench.backToOverview}
            </Button>
            <span className="text-sm font-medium">
              {stages.find((stage) => stage.id === focusedStage)?.label}
            </span>
          </div>
          <FocusGraph
            snapshot={snapshot}
            stage={focusedStage}
            selectedNodeKey={selectedNodeKey}
            onSelectNode={onSelectNode}
            t={t}
          />
          <MobileStageList
            stages={stages}
            stage={focusedStage}
            onFocus={setFocusedStage}
            onSelectNode={onSelectNode}
            t={t}
          />
        </>
      ) : (
        <>
          <div className="hidden min-h-[34rem] flex-1 md:block">
            <ReactFlow
              nodes={overviewNodes}
              edges={overviewEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
              minZoom={0.45}
              maxZoom={1.35}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              edgesFocusable={false}
              defaultEdgeOptions={{
                type: "straight",
                style: { stroke: EDGE_STROKE, strokeWidth: EDGE_WIDTH },
                markerEnd: arrowMarker(EDGE_STROKE),
              }}
              onNodeClick={(_, node) =>
                setFocusedStage(node.id.replace("stage:", "") as WorkflowStageId)
              }
              proOptions={{ hideAttribution: true }}
              className="bg-background"
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
              <Controls showInteractive={false} className="!rounded-md !border-border !shadow-sm" />
            </ReactFlow>
          </div>
          <MobileStageList
            stages={stages}
            stage={null}
            onFocus={setFocusedStage}
            onSelectNode={onSelectNode}
            t={t}
          />
        </>
      )}
    </div>
  );
}
