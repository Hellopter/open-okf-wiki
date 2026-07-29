/**
 * Definition v1 Wiki graph materialization (ADR 0035).
 *
 * Pure topology from an approved WikiRunSpec. WikiRuns inserts these rows and
 * edges after plan approve; the scheduler unlocks ready nodes from sealed
 * upstream outputs — this module does not execute Attempts.
 *
 * Depth: there is no recursive depth axis. workspace.orchestration.maxDepth is
 * ignored here (fossil field; see resolveOrchestration / WorkspaceOrchestrationSchema).
 * Topology caps are maxDomainFanOut and maxLeafFanOut only; leaf *concurrency*
 * is separate (domainConcurrency × min(2, maxLeafFanOut) in concurrency.ts).
 */

import {
  DEFAULT_ORCHESTRATION,
  type WikiRunNodeKind,
  type WikiRunSpec,
} from "@okf-wiki/contract";

export type BuildDefinitionV1Options = {
  /** Number of review seats (1–4). Default: DEFAULT_ORCHESTRATION.reviewCouncilSize (3). */
  reviewCouncilSize?: number;
  /**
   * Cap domains materialized from Spec (workspace.orchestration.maxDomainFanOut).
   * Default: DEFAULT_ORCHESTRATION.maxDomainFanOut (4), not the schema max (16).
   */
  maxDomainFanOut?: number;
  /**
   * Cap questions/leaves per domain (workspace.orchestration.maxLeafFanOut).
   * Topology only — not the leaf concurrency pool. Default: DEFAULT_ORCHESTRATION.maxLeafFanOut (6).
   */
  maxLeafFanOut?: number;
};

export type DefinitionV1Node = {
  key: string;
  kind: WikiRunNodeKind;
  /** Optional operator-facing detail (question text, lens, …). */
  detail?: Record<string, unknown>;
};

export type DefinitionV1Edge = {
  from: string;
  to: string;
};

export type DefinitionV1Graph = {
  nodes: DefinitionV1Node[];
  edges: DefinitionV1Edge[];
};

const REVIEW_LENSES = ["grounding", "coverage", "consistency", "general"] as const;

/**
 * Build the post-plan Definition v1 DAG.
 *
 * ```
 * plan ──► research.leaf.* ──► research.domain.* ──► write.root
 *   ╰───────────────────────────────────────────────► write.root (no domains)
 * write.root → validate.pre → review.seat.* → review.reduce
 *   → validate.final → prepare.publication → gate.publication → publish
 * ```
 *
 * `gate.plan` is already open/resolved before this runs; edges from `plan`
 * express the semantic dependency for attempt_inputs binding.
 */
export function buildDefinitionV1Graph(
  spec: WikiRunSpec,
  options?: BuildDefinitionV1Options,
): DefinitionV1Graph {
  const nodes: DefinitionV1Node[] = [];
  const edges: DefinitionV1Edge[] = [];
  const seen = new Set<string>();
  const councilSize = Math.max(
    1,
    Math.min(
      REVIEW_LENSES.length,
      Math.floor(options?.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize),
    ),
  );
  const lenses = REVIEW_LENSES.slice(0, councilSize);
  const maxDomainFanOut = Math.max(
    1,
    Math.min(16, Math.floor(options?.maxDomainFanOut ?? DEFAULT_ORCHESTRATION.maxDomainFanOut)),
  );
  const maxLeafFanOut = Math.max(
    1,
    Math.min(16, Math.floor(options?.maxLeafFanOut ?? DEFAULT_ORCHESTRATION.maxLeafFanOut)),
  );

  const addNode = (node: DefinitionV1Node): void => {
    if (seen.has(node.key)) return;
    seen.add(node.key);
    nodes.push(node);
  };

  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    edges.push({ from, to });
  };

  const domains = (spec.domains ?? []).slice(0, maxDomainFanOut);
  const domainKeys: string[] = [];

  for (const domain of domains) {
    const domainId = domain.id.trim();
    if (!domainId) continue;
    const domainKey = `research.domain.${domainId}`;
    domainKeys.push(domainKey);
    const questions = (domain.questions ?? []).slice(0, maxLeafFanOut);
    const leafKeys: string[] = [];

    if (questions.length === 0) {
      // Domains without questions still get one leaf so domain reduce has input.
      const leafKey = `research.leaf.${domainId}.1`;
      leafKeys.push(leafKey);
      addNode({
        key: leafKey,
        kind: "research.leaf",
        detail: {
          domainId,
          questionIndex: 1,
          question: domain.scope || domain.title || domainId,
        },
      });
      addEdge("plan", leafKey);
    } else {
      questions.forEach((question, index) => {
        const leafKey = `research.leaf.${domainId}.${index + 1}`;
        leafKeys.push(leafKey);
        addNode({
          key: leafKey,
          kind: "research.leaf",
          detail: {
            domainId,
            questionIndex: index + 1,
            question,
            scope: domain.scope ?? "",
            title: domain.title ?? domainId,
          },
        });
        addEdge("plan", leafKey);
      });
    }

    addNode({
      key: domainKey,
      kind: "research.domain",
      detail: {
        domainId,
        title: domain.title ?? domainId,
        scope: domain.scope ?? "",
        critical: domain.critical === true,
        questions,
      },
    });
    for (const leafKey of leafKeys) addEdge(leafKey, domainKey);
  }

  addNode({ key: "write.root", kind: "write.root" });
  if (domainKeys.length > 0) {
    for (const domainKey of domainKeys) addEdge(domainKey, "write.root");
  } else {
    addEdge("plan", "write.root");
  }

  addNode({ key: "validate.pre", kind: "validate.pre" });
  addEdge("write.root", "validate.pre");

  const seatKeys: string[] = [];
  for (const lens of lenses) {
    const seatKey = `review.seat.${lens}`;
    seatKeys.push(seatKey);
    addNode({
      key: seatKey,
      kind: "review.seat",
      detail: { lens },
    });
    addEdge("validate.pre", seatKey);
  }

  addNode({ key: "review.reduce", kind: "review.reduce" });
  for (const seatKey of seatKeys) addEdge(seatKey, "review.reduce");

  // Happy path skips explicit repair nodes; RerunNode / publication revise insert them later.
  addNode({ key: "validate.final", kind: "validate.final" });
  addEdge("review.reduce", "validate.final");

  addNode({ key: "prepare.publication", kind: "prepare.publication" });
  addEdge("validate.final", "prepare.publication");

  addNode({ key: "gate.publication", kind: "gate.publication" });
  addEdge("prepare.publication", "gate.publication");

  addNode({ key: "publish", kind: "publish" });
  addEdge("gate.publication", "publish");

  return { nodes, edges };
}

/** Node kinds executed by the optional PiAttemptExecutor (model / fixture agent). */
export const PI_ATTEMPT_KINDS: ReadonlySet<WikiRunNodeKind> = new Set([
  "plan",
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
export const GATE_KINDS: ReadonlySet<WikiRunNodeKind> = new Set(["gate.plan", "gate.publication"]);

export function isPiAttemptKind(kind: string): boolean {
  return PI_ATTEMPT_KINDS.has(kind as WikiRunNodeKind);
}

export function isMechanicalAttemptKind(kind: string): boolean {
  return MECHANICAL_ATTEMPT_KINDS.has(kind as WikiRunNodeKind);
}

export function isGateKind(kind: string): boolean {
  return GATE_KINDS.has(kind as WikiRunNodeKind);
}
