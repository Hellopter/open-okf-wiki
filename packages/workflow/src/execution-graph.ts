/**
 * Definition graph materialization (WikiRuns schema v2 / ADR 0035).
 *
 * Pure topology from an approved WikiRunSpec + host-compiled ExecutionPlan.
 * WikiRuns inserts these rows and edges after plan approve; the scheduler unlocks
 * ready nodes from sealed upstream outputs — this module does not execute Attempts.
 *
 * Hard-cut (Phase 1): no silent `.slice` fan-out. Caps are enforced by
 * `compileExecutionPlan` which throws when Spec exceeds maxDomainFanOut / maxLeafFanOut.
 *
 * Topology caps are maxDomainFanOut and maxLeafFanOut only; leaf *concurrency*
 * is separate (domainConcurrency × min(leafConcurrency, maxLeafFanOut) in concurrency.ts).
 */

import { type ExecutionPlan, type WikiRunNodeKind, type WikiRunSpec } from "@okf-wiki/contract";
import { type CompileExecutionPlanCaps, compileExecutionPlan } from "./plan-compiler.js";

export type BuildExecutionGraphOptions = CompileExecutionPlanCaps;

export type ExecutionGraphNode = {
  key: string;
  kind: WikiRunNodeKind;
  /** Optional operator-facing detail (question text, lens, …). */
  detail?: Record<string, unknown>;
};

export type ExecutionGraphEdge = {
  from: string;
  to: string;
};

export type ExecutionGraph = {
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
};

/**
 * Build the post-plan Definition DAG from a host-compiled ExecutionPlan + Spec.
 *
 * ```
 * plan ──► research.leaf.* ──► research.domain.* ──► write.root  (multi-leaf cluster)
 * plan ──► research.leaf.* ─────────────────────────► write.root  (single-cluster direct)
 *   ╰───────────────────────────────────────────────► write.root (no domains)
 * research frontier ──► plan.adapt.1 ──► write.root (bounded gap discovery)
 * write.root → validate.pre → review.seat.* → review.reduce
 *   → gate.fix → validate.final → prepare.publication → gate.publication → publish
 * ```
 * Phase 7: single-leaf domains skip the domain reducer (work unit merge / light path).
 *
 * `gate.plan` is already open/resolved before this runs; edges from `plan`
 * express the semantic dependency for attempt_inputs binding.
 * `gate.fix` auto-passes when review is clean; opens for HITL on blocking defects.
 */
export function buildExecutionGraphFromPlan(
  plan: ExecutionPlan,
  spec: WikiRunSpec,
): ExecutionGraph {
  const nodes: ExecutionGraphNode[] = [];
  const edges: ExecutionGraphEdge[] = [];
  const seen = new Set<string>();

  const addNode = (node: ExecutionGraphNode): void => {
    if (seen.has(node.key)) return;
    seen.add(node.key);
    nodes.push(node);
  };

  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    edges.push({ from, to });
  };

  const domainMeta = new Map(
    (spec.domains ?? []).map((d) => [
      d.id.trim(),
      {
        title: d.title ?? d.id,
        scope: d.scope ?? "",
        critical: d.critical === true,
      },
    ]),
  );

  // Group leaf work units by domain for research.domain nodes.
  const leavesByDomain = new Map<
    string,
    Array<{ key: string; unit: ExecutionPlan["workUnits"][number] }>
  >();
  for (const unit of plan.workUnits) {
    const domainId = unit.domainId?.trim();
    if (!domainId) continue;
    const questionIndex = (() => {
      const match = /^leaf:[^:]+:(\d+)$/.exec(unit.id);
      return match ? Number(match[1]) : undefined;
    })();
    const leafKey =
      questionIndex !== undefined
        ? `research.leaf.${domainId}.${questionIndex}`
        : `research.leaf.${domainId}.${(leavesByDomain.get(domainId)?.length ?? 0) + 1}`;
    const question =
      unit.questions[0] ??
      domainMeta.get(domainId)?.scope ??
      domainMeta.get(domainId)?.title ??
      domainId;
    addNode({
      key: leafKey,
      kind: "research.leaf",
      detail: {
        domainId,
        ...(questionIndex !== undefined ? { questionIndex } : {}),
        question,
        scope: unit.scope,
        title: domainMeta.get(domainId)?.title ?? domainId,
      },
    });
    addEdge("plan", leafKey);
    const list = leavesByDomain.get(domainId) ?? [];
    list.push({ key: leafKey, unit });
    leavesByDomain.set(domainId, list);
  }

  const multiDomainKeys: string[] = [];
  for (const [domainId, leaves] of leavesByDomain) {
    const domainKey = `research.domain.${domainId}`;
    const meta = domainMeta.get(domainId);
    const questions = leaves.flatMap((l) => l.unit.questions);
    if (leaves.length === 1) {
      // single-cluster direct to Writer (work unit merge / cognitive locality)
      addEdge(leaves[0].key, "write.root");
    } else {
      addNode({
        key: domainKey,
        kind: "research.domain",
        detail: {
          domainId,
          title: meta?.title ?? domainId,
          scope: meta?.scope ?? leaves[0]?.unit.scope ?? "",
          critical: meta?.critical === true,
          questions,
        },
      });
      for (const leaf of leaves) addEdge(leaf.key, domainKey);
      multiDomainKeys.push(domainKey);
    }
  }

  addNode({ key: "write.root", kind: "write.root" });
  if (multiDomainKeys.length > 0) {
    for (const domainKey of multiDomainKeys) addEdge(domainKey, "write.root");
  } else if (leavesByDomain.size === 0) {
    // No research work units at all: plan feeds Writer directly.
    addEdge("plan", "write.root");
  }
  // single-cluster leaves already edged to write.root above.

  // Adaptation is an explicit plan decision. Light paths retain their direct
  // writer edges and avoid an otherwise needless model-backed attempt.
  if (plan.adaptation.required) {
    addNode({ key: "plan.adapt.1", kind: "plan.adapt", detail: { adaptRound: 1 } });
    if (multiDomainKeys.length > 0) {
      for (const domainKey of multiDomainKeys) addEdge(domainKey, "plan.adapt.1");
    } else if (leavesByDomain.size === 0) {
      addEdge("plan", "plan.adapt.1");
    } else {
      for (const leaves of leavesByDomain.values()) {
        for (const leaf of leaves) addEdge(leaf.key, "plan.adapt.1");
      }
    }
    addEdge("plan.adapt.1", "write.root");
  }

  addNode({ key: "validate.pre", kind: "validate.pre" });
  addEdge("write.root", "validate.pre");

  // Empty reviewLenses when Spec acceptance.reviewRequired=false (compile allows).
  // When empty, validate.pre feeds review.reduce directly (no seats).
  const lenses = plan.reviewLenses;

  const seatKeys: string[] = [];
  lenses.forEach((lens, seatIndex) => {
    const seatKey = `review.seat.${lens}`;
    seatKeys.push(seatKey);
    addNode({
      key: seatKey,
      kind: "review.seat",
      detail: { lens, seatIndex },
    });
    addEdge("validate.pre", seatKey);
  });

  addNode({ key: "review.reduce", kind: "review.reduce" });
  if (seatKeys.length > 0) {
    for (const seatKey of seatKeys) addEdge(seatKey, "review.reduce");
  } else {
    // No council seats: mechanical reduce still runs (fail-closed if reviewRequired).
    addEdge("validate.pre", "review.reduce");
  }

  // Fix gate sits between council reduce and final validate. Clean reviews
  // auto-pass; blocking defects open HITL (pass / fix / revise / deny).
  // Explicit repair.N nodes are inserted only on ResolveGate(fix) or auto mechanical repair.
  addNode({ key: "gate.fix", kind: "gate.fix" });
  addEdge("review.reduce", "gate.fix");

  addNode({ key: "validate.final", kind: "validate.final" });
  addEdge("gate.fix", "validate.final");

  addNode({ key: "prepare.publication", kind: "prepare.publication" });
  addEdge("validate.final", "prepare.publication");

  addNode({ key: "gate.publication", kind: "gate.publication" });
  addEdge("prepare.publication", "gate.publication");

  addNode({ key: "publish", kind: "publish" });
  addEdge("gate.publication", "publish");

  return { nodes, edges };
}

/**
 * Build the post-plan Definition DAG from Spec + workspace caps.
 * Compiles an ExecutionPlan first (throws on over-cap); never silently truncates.
 *
 */
export function buildExecutionGraph(
  spec: WikiRunSpec,
  options?: BuildExecutionGraphOptions,
): ExecutionGraph {
  const plan = compileExecutionPlan(spec, options);
  return buildExecutionGraphFromPlan(plan, spec);
}

/** Node kinds executed by the optional PiAttemptExecutor (model / fixture agent). */
export const PI_ATTEMPT_KINDS: ReadonlySet<WikiRunNodeKind> = new Set([
  "plan",
  "plan.adapt",
  "research.leaf",
  "research.domain",
  "write.root",
  "review.seat",
  "repair",
]);

/** Mechanical kinds owned entirely by WikiRuns (core validate/publish primitives). */
export const MECHANICAL_ATTEMPT_KINDS: ReadonlySet<WikiRunNodeKind> = new Set([
  "validate.pre",
  "validate.final",
  "prepare.publication",
  "publish",
  "review.reduce",
]);

/** Gates wait for ResolveGate; never claimed for execute. */
export const GATE_KINDS: ReadonlySet<WikiRunNodeKind> = new Set([
  "gate.plan",
  "gate.fix",
  "gate.publication",
]);

export function isPiAttemptKind(kind: string): boolean {
  return PI_ATTEMPT_KINDS.has(kind as WikiRunNodeKind);
}

export function isMechanicalAttemptKind(kind: string): boolean {
  return MECHANICAL_ATTEMPT_KINDS.has(kind as WikiRunNodeKind);
}

export function isGateKind(kind: string): boolean {
  return GATE_KINDS.has(kind as WikiRunNodeKind);
}
