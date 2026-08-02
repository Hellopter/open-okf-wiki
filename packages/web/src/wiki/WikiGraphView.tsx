/**
 * Dependency-free SVG cross-link graph for the Published Wiki
 * (Wiki Visualization: deterministic, read-only projection).
 *
 * Deterministic circular layout: nodes sorted by path sit on a circle, edges
 * are straight arrows. Fill color (chart tokens) encodes frontmatter `type`;
 * the ring's stroke pattern encodes the OKF trust tier — solid for
 * human-reviewed, dashed for machine-confirmed — so hue never carries two
 * meanings on one node. Click navigates to the page.
 */

import { useMemo, useState } from "react";
import type { WikiGraphNode, WikiGraphResponse } from "../api";

const TYPE_PALETTE: Record<string, string> = {
  Overview: "var(--chart-1)",
  Architecture: "var(--chart-2)",
  Module: "var(--chart-3)",
  Flow: "var(--chart-4)",
  Concept: "var(--chart-5)",
};
const DEFAULT_NODE_COLOR = "var(--muted-foreground)";

const TRUST_RING: Record<WikiGraphNode["trustTier"], { dash?: string } | null> = {
  unverified: null,
  "machine-confirmed": { dash: "3 3" },
  "human-reviewed": {},
};

export type WikiGraphViewProps = {
  graph: WikiGraphResponse;
  activePath?: string;
  onSelect: (pagePath: string) => void;
  ariaLabel: string;
  emptyLabel: string;
};

type LayoutNode = WikiGraphNode & { x: number; y: number; color: string };

const WIDTH = 860;
const HEIGHT = 620;

function layoutNodes(nodes: WikiGraphNode[]): LayoutNode[] {
  const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = Math.min(cx, cy) - 90;
  const count = Math.max(sorted.length, 1);
  return sorted.map((node, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    return {
      ...node,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      color: (node.type && TYPE_PALETTE[node.type]) || DEFAULT_NODE_COLOR,
    };
  });
}

export function WikiGraphView({
  graph,
  activePath,
  onSelect,
  ariaLabel,
  emptyLabel,
}: WikiGraphViewProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const nodes = useMemo(() => layoutNodes(graph.nodes), [graph.nodes]);
  const byPath = useMemo(() => new Map(nodes.map((n) => [n.path, n])), [nodes]);
  const edges = useMemo(
    () => graph.edges.filter((e) => byPath.has(e.from) && byPath.has(e.to)),
    [graph.edges, byPath],
  );

  const focus = hovered ?? activePath ?? null;
  const connected = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const edge of edges) {
      if (edge.from === focus) set.add(edge.to);
      if (edge.to === focus) set.add(edge.from);
    }
    return set;
  }, [focus, edges]);

  const types = useMemo(
    () => [...new Set(nodes.map((n) => n.type ?? ""))].filter(Boolean).sort(),
    [nodes],
  );

  if (nodes.length === 0 || edges.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="wiki-graph-view">
        {nodes.length === 0 ? (
          <p className="p-6 text-muted-foreground">{emptyLabel}</p>
        ) : (
          <>
            <p className="px-6 pt-4 text-sm text-muted-foreground">{emptyLabel}</p>
            <GraphSvg
              nodes={nodes}
              edges={edges}
              connected={connected}
              activePath={activePath}
              ariaLabel={ariaLabel}
              onSelect={onSelect}
              setHovered={setHovered}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="wiki-graph-view">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3 text-xs text-muted-foreground">
        {types.map((type) => (
          <span key={type} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: TYPE_PALETTE[type] ?? DEFAULT_NODE_COLOR }}
            />
            {type}
          </span>
        ))}
      </div>
      <GraphSvg
        nodes={nodes}
        edges={edges}
        connected={connected}
        activePath={activePath}
        ariaLabel={ariaLabel}
        onSelect={onSelect}
        setHovered={setHovered}
      />
    </div>
  );
}

function GraphSvg({
  nodes,
  edges,
  connected,
  activePath,
  ariaLabel,
  onSelect,
  setHovered,
}: {
  nodes: LayoutNode[];
  edges: Array<{ from: string; to: string }>;
  connected: Set<string> | null;
  activePath?: string;
  ariaLabel: string;
  onSelect: (pagePath: string) => void;
  setHovered: (path: string | null) => void;
}) {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={ariaLabel}
      className="min-h-0 w-full flex-1"
      data-testid="wiki-graph-svg"
    >
      <defs>
        <marker
          id="wiki-graph-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="currentColor" opacity="0.45" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const from = byPath.get(edge.from)!;
        const to = byPath.get(edge.to)!;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        // Trim the line at the node radius so arrowheads sit on the rim.
        const r = 14;
        const x1 = from.x + (dx / len) * r;
        const y1 = from.y + (dy / len) * r;
        const x2 = to.x - (dx / len) * r;
        const y2 = to.y - (dy / len) * r;
        const dimmed = connected ? !(connected.has(edge.from) && connected.has(edge.to)) : false;
        const focused = connected?.has(edge.from) && connected.has(edge.to);
        return (
          <line
            key={`${edge.from}>${edge.to}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeWidth={focused ? 1.8 : 1}
            opacity={dimmed ? 0.12 : 0.4}
            markerEnd="url(#wiki-graph-arrow)"
          />
        );
      })}
      {nodes.map((node) => {
        const dimmed = connected ? !connected.has(node.path) : false;
        const active = node.path === activePath;
        const ring = TRUST_RING[node.trustTier];
        const label = node.title || node.path;
        return (
          <g
            key={node.path}
            role="button"
            tabIndex={0}
            aria-label={label}
            data-testid="wiki-graph-node"
            data-page={node.path}
            className="cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            opacity={dimmed ? 0.25 : 1}
            onMouseEnter={() => setHovered(node.path)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(node.path)}
            onBlur={() => setHovered(null)}
            onClick={() => onSelect(node.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(node.path);
              }
            }}
          >
            <title>
              {label}
              {node.description ? ` — ${node.description}` : ""}
            </title>
            {ring ? (
              <circle
                cx={node.x}
                cy={node.y}
                r={16.5}
                fill="none"
                stroke="var(--success)"
                strokeWidth={2}
                strokeDasharray={ring.dash}
              />
            ) : null}
            <circle
              cx={node.x}
              cy={node.y}
              r={13}
              fill={node.color}
              stroke={active ? "currentColor" : "transparent"}
              strokeWidth={active ? 2 : 0}
            />
            <text x={node.x} y={node.y + 30} textAnchor="middle" className="fill-current text-2xs">
              {label.length > 24 ? `${label.slice(0, 23)}…` : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
