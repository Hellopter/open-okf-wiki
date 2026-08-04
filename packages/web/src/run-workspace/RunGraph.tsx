import type { WikiRunNode, WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
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
import {
  ContextFillMicroDot,
  describeNodeStatus,
  formatNodeContextHoverTitle,
  type NodeContextFillSummary,
  nodeContextFillSummary,
  stageContextFillSummary,
} from "@/components/agent-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMessage, type MessageTree } from "../i18n";
import {
  allNodesPositioned,
  buildElkLayoutInput,
  buildHandlePlan,
  contentNodeHeight,
  degreeMaps,
  elkLayoutOptions,
  FOCUS_NODE_HEIGHT,
  FOCUS_NODE_WIDTH,
  layoutResearchFocus,
  packPositionsByModelOrder,
  simplifyDisplayEdges,
} from "./graph-layout";
import {
  buildFocusTopology,
  buildWorkflowStages,
  hasDurablePlanScouts,
  injectPlanScoutDisplayNodes,
  orderedNodesForLayout,
  type PlanScoutDisplay,
  planScoutKindClass,
  projectCollapsedResearchLeaves,
  researchDomainLeafGroups,
  shouldCollapseResearchLeaves,
  type WorkflowEdgeRelation,
  type WorkflowStage,
  type WorkflowStageId,
} from "./workflow-topology";

/**
 * Layout + chrome follow React Flow / ELK guidance:
 * - content-sized nodes (capped); multi-handles use % top on the card
 * - multi-handles + port order for fan-out/join (elkjs-multiple-handles)
 * - edge stroke beats background; marker color matches stroke
 * - assign handles by laid-out Y so orthogonal edges stay parallel, not center-bundled
 * @see https://reactflow.dev/examples/layout/elkjs
 * @see https://reactflow.dev/examples/layout/elkjs-multiple-handles
 */
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
  /** Single micro-dot for densest/running fill in this stage (null when none). */
  contextFill: NodeContextFillSummary | null;
  hoverTitle: string;
  fillAriaLabel?: string;
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
  /** Latest attempt context fill for micro-dot + hover (null when unknown). */
  contextFill: NodeContextFillSummary | null;
  hoverTitle: string;
  fillAriaLabel?: string;
};
type OverviewNode = Node<OverviewNodeData, "overview">;
type FocusNode = Node<FocusNodeData, "focus">;

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

function OverviewCard({ data }: NodeProps<OverviewNode>) {
  const fill = data.contextFill;
  return (
    <div
      title={data.hoverTitle}
      className={`flex h-[4.75rem] w-[216px] flex-col justify-between rounded-lg border px-3.5 py-3 shadow-sm ${stateClass(data.stage.state)}`}
    >
      <Handle id="left" type="target" position={Position.Left} className={handleClassName(false)} />
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
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {fill ? (
            <ContextFillMicroDot
              usage={fill.usage}
              phase={fill.phase}
              ariaLabel={data.fillAriaLabel}
            />
          ) : null}
          <Badge variant="outline" className="shrink-0">
            {data.stateLabel}
          </Badge>
        </span>
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
  const fill = data.contextFill;
  return (
    <div
      title={data.hoverTitle}
      className={`relative flex h-full w-full flex-col justify-center overflow-hidden rounded-lg border px-3 py-2.5 shadow-sm transition-shadow ${
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
        {fill ? (
          <ContextFillMicroDot
            usage={fill.usage}
            phase={fill.phase}
            ariaLabel={data.fillAriaLabel}
            className="mt-0.5"
          />
        ) : null}
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

const SEMANTIC_KIND_FROM_TASK = /^semantic:(domain|flow|concept)$/;
const THEMATIC_KIND_FROM_TASK = /^thematic:/;

function nodeLabel(node: WikiRunNode, t: MessageTree): string {
  if (node.kind === "plan.adapt" && /^\d+$/.test(node.label.trim())) return t.workbench.planAdapt;
  if (node.kind === "plan.discover.reduce") {
    return t.workbench.planDiscoverReduce;
  }
  if (node.kind === "plan.scout") {
    const scoutKind = node.detail?.scoutKind?.trim() ?? "";
    const taskLabel = node.detail?.taskLabel?.trim() ?? "";
    const kindClass = planScoutKindClass(scoutKind || taskLabel.split(":")[0]);

    // Semantic discovery scouts: prefer i18n kind labels over host English chips.
    if (kindClass === "semantic" || SEMANTIC_KIND_FROM_TASK.test(taskLabel)) {
      const semantic = scoutKind || taskLabel.replace(/^semantic:/, "");
      if (semantic === "domain") return t.workbench.planScoutSemanticDomain;
      if (semantic === "flow") return t.workbench.planScoutSemanticFlow;
      if (semantic === "concept") return t.workbench.planScoutSemanticConcept;
    }

    // Unit surveys: source / surface with id when available.
    if (kindClass === "unit" || scoutKind === "source" || scoutKind === "surface") {
      if (scoutKind === "source" || taskLabel.startsWith("source:")) {
        const id =
          node.detail?.sourceId?.trim() ||
          (taskLabel.startsWith("source:") ? taskLabel.slice("source:".length) : "");
        return id
          ? formatMessage(t.workbench.planScoutUnitSourceId, { id })
          : t.workbench.planScoutUnitSource;
      }
      if (scoutKind === "surface" || taskLabel.startsWith("surface:")) {
        const unit =
          node.detail?.unitId?.trim() ||
          (taskLabel.startsWith("surface:") ? taskLabel.slice("surface:".length) : "");
        return unit
          ? formatMessage(t.workbench.planScoutUnitSurfaceId, { id: unit })
          : t.workbench.planScoutUnitSurface;
      }
    }

    // Thematic spine: prefer i18n over host English "Scout · thematic:…" chips.
    const short = node.key.startsWith("plan.scout.")
      ? node.key.slice("plan.scout.".length)
      : node.key;
    if (kindClass === "thematic" || THEMATIC_KIND_FROM_TASK.test(taskLabel)) {
      const thematic = scoutKind || taskLabel.replace(/^thematic:/, "") || short;
      return formatMessage(t.workbench.planScoutThematicId, { kind: thematic });
    }

    // Host-projected label / key fallback.
    const label = node.label.trim();
    if (label) return label;
    return `${t.workbench.planScout} · ${short}`;
  }
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
  planScouts,
  t,
}: {
  snapshot: WikiRunSnapshot;
  stage: WorkflowStageId;
  selectedNodeKey: string | null;
  onSelectNode: (nodeKey: string) => void;
  planScouts?: PlanScoutDisplay[];
  t: MessageTree;
}) {
  const baseTopology = useMemo(() => {
    const topology = buildFocusTopology(snapshot, stage);
    // Prefer durable plan.scout nodes from the snapshot. Inject only for legacy
    // runs that nested scouts under the plan attempt (no durable DAG members).
    if (stage !== "plan" || !planScouts?.length) return topology;
    if (hasDurablePlanScouts(topology.nodes) || hasDurablePlanScouts(snapshot.nodes)) {
      return topology;
    }
    const planNode = topology.nodes.find((node) => node.key === "plan" || node.kind === "plan");
    if (!planNode) return topology;
    const injected = injectPlanScoutDisplayNodes(
      topology.nodes,
      topology.edges,
      planScouts,
      planNode,
    );
    if (injected.nodes.length === topology.nodes.length) return topology;
    // Recompute context keys from plan-stage nodes only.
    const planStageKeys = new Set(
      injected.nodes
        .filter(
          (node) =>
            node.kind === "freeze" ||
            node.kind === "plan" ||
            node.kind === "plan.scout" ||
            node.kind === "plan.discover.reduce" ||
            node.kind === "gate.plan",
        )
        .map((node) => node.key),
    );
    return {
      nodes: injected.nodes,
      edges: injected.edges,
      contextNodeKeys: new Set(
        injected.nodes.filter((node) => !planStageKeys.has(node.key)).map((node) => node.key),
      ),
      topologyKey: JSON.stringify({
        base: topology.topologyKey,
        scouts: planScouts.map((s) => [s.kind, s.ok ?? null]),
      }),
    };
  }, [snapshot, stage, planScouts]);
  const domainGroups = useMemo(() => researchDomainLeafGroups(baseTopology), [baseTopology]);
  const collapseEnabled = useMemo(() => shouldCollapseResearchLeaves(baseTopology), [baseTopology]);
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

  const displayEdges = useMemo(() => simplifyDisplayEdges(topology.edges), [topology.edges]);
  const domainCollapseKeys = useMemo(() => {
    if (!collapseEnabled) return undefined;
    return new Set(
      [...domainGroups.keys()].filter((key) =>
        topology.nodes.some((node) => node.key === key && node.kind === "research.domain"),
      ),
    );
  }, [collapseEnabled, domainGroups, topology.nodes]);

  const orderedNodes = useMemo(
    () =>
      orderedNodesForLayout(
        topology,
        collapseEnabled ? { expandedDomainKeys: expandedDomains } : undefined,
      ),
    [topology, collapseEnabled, expandedDomains],
  );
  const { outDegree, inDegree } = useMemo(() => degreeMaps(displayEdges), [displayEdges]);

  const layoutInput = useMemo(
    () =>
      buildElkLayoutInput(orderedNodes, displayEdges, {
        outDegree,
        inDegree,
        domainCollapseKeys,
      }),
    [orderedNodes, displayEdges, outDegree, inDegree, domainCollapseKeys],
  );

  const topologyNodeKeys = useMemo(() => topology.nodes.map((node) => node.key), [topology.nodes]);
  const topologyNodeCount = topologyNodeKeys.length;
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);

  // Stage / base run change: drop stale coords. Expand/collapse keeps prior positions
  // until ELK returns so the graph does not flash to a grid fallback.
  useEffect(() => {
    setPositions({});
  }, [stage, baseTopology.topologyKey]);

  useEffect(() => {
    // Research collapse (full/partial/collapsed): deterministic columns so leaf
    // clusters share vertical space with their domain (ELK layers cannot).
    if (collapseEnabled && stage === "research") {
      setPositions(
        layoutResearchFocus(orderedNodes, displayEdges, {
          domainGroups,
          expandedDomainKeys: expandedDomains,
          domainCollapseKeys,
        }),
      );
      return;
    }

    let active = true;
    const elk = new ELK();
    void elk
      .layout({
        id: "focus",
        layoutOptions: elkLayoutOptions(topologyNodeCount),
        ...layoutInput,
      })
      .then((layout) => {
        if (!active) return;
        const raw = Object.fromEntries(
          (layout.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
        );
        // Restack each X-layer in model order so expanded domain clusters stay on top.
        const orderedNodeKeys = layoutInput.children.map((child) => child.id);
        const heightByNode = Object.fromEntries(
          layoutInput.children.map((child) => [child.id, child.height]),
        );
        const next = packPositionsByModelOrder(orderedNodeKeys, raw, heightByNode);
        // Full ELK result replaces coords; do not clear beforehand (keeps prior layout stable).
        setPositions(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [
    collapseEnabled,
    stage,
    orderedNodes,
    displayEdges,
    domainGroups,
    expandedDomains,
    domainCollapseKeys,
    layoutInput,
    topologyNodeCount,
  ]);

  const handlePlan = useMemo(() => {
    if (!allNodesPositioned(topologyNodeKeys, positions)) return null;
    return buildHandlePlan({ ...topology, edges: displayEdges }, positions, {
      domainCollapseKeys,
    });
  }, [positions, topology, displayEdges, topologyNodeKeys, domainCollapseKeys]);

  const layoutSettled = handlePlan != null && allNodesPositioned(topologyNodeKeys, positions);

  // Fit only on stage / base topology change — not every expand/collapse.
  const fitSignature = `${stage}:${baseTopology.topologyKey}`;
  const [fittedSignature, setFittedSignature] = useState<string | null>(null);

  useEffect(() => {
    if (!flow || !layoutSettled) return;
    if (fittedSignature === fitSignature) return;
    const frame = requestAnimationFrame(() => {
      flow.fitView({
        padding: topologyNodeCount > 12 ? 0.08 : 0.14,
        minZoom: topologyNodeCount > 12 ? 0.42 : 0.55,
        maxZoom: 1.05,
        duration: 180,
      });
      setFittedSignature(fitSignature);
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, layoutSettled, fitSignature, fittedSignature, topologyNodeCount]);

  const tokenFormatters = useMemo(
    () => ({
      in: (n: string) => formatMessage(t.workbench.context.inTokens, { n }),
      out: (n: string) => formatMessage(t.workbench.context.outTokens, { n }),
      tools: (n: string) => formatMessage(t.workbench.context.toolCalls, { n }),
    }),
    [t.workbench.context.inTokens, t.workbench.context.outTokens, t.workbench.context.toolCalls],
  );

  const nodes: FocusNode[] = useMemo(() => {
    const plan = handlePlan;
    return orderedNodes.map((node, index) => {
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
      const displayLabel = nodeLabel(node, t);
      const contextFill = nodeContextFillSummary(
        snapshot.attempts,
        node.key,
        tokenFormatters,
      );
      const fillAriaLabel = contextFill
        ? contextFill.percent != null
          ? formatMessage(t.workbench.context.graphFillAria, {
              percent: Math.round(contextFill.percent),
            })
          : t.workbench.context.graphFillAriaUnknown
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
          height:
            plan?.heightByNode.get(node.key) ??
            contentNodeHeight(node, {
              domainCollapseChrome: domainCollapseKeys?.has(node.key) ?? false,
            }),
        },
        data: {
          node,
          displayLabel,
          stateLabel: stateLabel(node.state, t),
          selected: node.key === selectedNodeKey,
          context: topology.contextNodeKeys.has(node.key),
          sourceHandleIds,
          targetHandleIds,
          domainCollapse,
          contextFill,
          hoverTitle: formatNodeContextHoverTitle(displayLabel, contextFill),
          fillAriaLabel,
        },
      };
    });
  }, [
    orderedNodes,
    topology.contextNodeKeys,
    positions,
    handlePlan,
    selectedNodeKey,
    t,
    collapseEnabled,
    domainGroups,
    domainCollapseKeys,
    expandedDomains,
    toggleDomain,
    snapshot.attempts,
    tokenFormatters,
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
          key={stage}
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
  planScouts,
  t,
}: {
  snapshot: WikiRunSnapshot;
  selectedNodeKey: string | null;
  focusedStage: WorkflowStageId | null;
  onFocusedStageChange: (stage: WorkflowStageId | null) => void;
  onSelectNode: (nodeKey: string) => void;
  /** Display-only plan scout receipts (not durable DAG nodes). */
  planScouts?: PlanScoutDisplay[];
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
  const overviewTokenFormatters = useMemo(
    () => ({
      in: (n: string) => formatMessage(t.workbench.context.inTokens, { n }),
      out: (n: string) => formatMessage(t.workbench.context.outTokens, { n }),
      tools: (n: string) => formatMessage(t.workbench.context.toolCalls, { n }),
    }),
    [t.workbench.context.inTokens, t.workbench.context.outTokens, t.workbench.context.toolCalls],
  );
  const overviewNodes: OverviewNode[] = stages.map((stage, index) => {
    const contextFill = stageContextFillSummary(
      snapshot.attempts,
      stage.nodes,
      overviewTokenFormatters,
    );
    const fillAriaLabel = contextFill
      ? contextFill.percent != null
        ? formatMessage(t.workbench.context.graphFillAria, {
            percent: Math.round(contextFill.percent),
          })
        : t.workbench.context.graphFillAriaUnknown
      : undefined;
    return {
      id: `stage:${stage.id}`,
      type: "overview" as const,
      position: { x: index * OVERVIEW_STEP_X, y: 100 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        stage,
        stateLabel: stateLabel(stage.state, t),
        showFeedbackHandles: hasFeedback,
        contextFill,
        hoverTitle: formatNodeContextHoverTitle(stage.label, contextFill),
        fillAriaLabel,
      },
    };
  });
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
            planScouts={planScouts}
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
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--border)"
              />
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
