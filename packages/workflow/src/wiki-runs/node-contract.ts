/**
 * Finite NodeContract registry — single source for required inputs, outputs,
 * and projection mode (Phase 2 hard-cut).
 *
 * Binding validates required roles after attempt_inputs freeze; materialize
 * (agent) projects sealed artifacts into workDir/inputs/ using the same roles.
 */

export type ProjectionMode = "inline" | "mounted" | "handle" | "audit-only";

export type InputRequirement = {
  /** Logical role; "research" matches exact or namespaced `*:research`. */
  role: string;
  artifactKind?: string;
  required: boolean;
  projection: ProjectionMode;
  /** Relative path under attempt workDir inputs/ when projection is mounted. */
  mountPath?: string;
};

export type OutputRequirement = {
  role: string;
  artifactKind: string;
};

export type NodeContract = {
  kind: string;
  requiredInputs: InputRequirement[];
  outputs: OutputRequirement[];
  execution: "pi" | "mechanical" | "gate";
};

/** True for research receipt roles (exact or namespaced leaf/domain outputs). */
export function isResearchRole(role: string): boolean {
  return role === "research" || role.endsWith(":research");
}

/** True for review seat receipt roles. */
export function isReviewSeatRole(role: string): boolean {
  return role === "review_seat" || role.endsWith(":review_seat");
}

function matchesRole(requirement: string, bound: string): boolean {
  if (requirement === bound) return true;
  if (requirement === "research") return isResearchRole(bound);
  if (requirement === "review_seat") return isReviewSeatRole(bound);
  // Prefix: allow exact well-known or namespaced `nodeKey:role`.
  if (bound.endsWith(`:${requirement}`)) return true;
  return false;
}

/** Whether bound roles satisfy one InputRequirement (at least one match when required). */
export function roleSatisfied(requirement: InputRequirement, boundRoles: readonly string[]): boolean {
  const hit = boundRoles.some((role) => matchesRole(requirement.role, role));
  if (requirement.required) return hit;
  return true;
}

/**
 * Throw if any required input role is missing from the bound attempt envelope.
 * Optional roles never fail closed here (projection may still skip them).
 */
export function validateBoundInputs(
  contract: NodeContract,
  boundRoles: readonly string[],
): void {
  const missing: string[] = [];
  for (const req of contract.requiredInputs) {
    if (!req.required) continue;
    if (!roleSatisfied(req, boundRoles)) missing.push(req.role);
  }
  if (missing.length > 0) {
    throw new Error(
      `node ${contract.kind} missing required sealed input role(s): ${missing.join(", ")} ` +
        `(bound: ${boundRoles.length ? boundRoles.join(", ") : "(none)"})`,
    );
  }
}

const SOURCES: InputRequirement = {
  role: "sources",
  artifactKind: "snapshot_set",
  required: true,
  projection: "mounted",
  mountPath: "../sources/", // sources/ is sibling of inputs/ (legacy mount)
};

const SKILL: InputRequirement = {
  role: "skill",
  artifactKind: "skill",
  required: true,
  projection: "mounted",
  mountPath: "../skill/",
};

const FROZEN_MANIFEST: InputRequirement = {
  role: "frozen_run_manifest",
  artifactKind: "manifest",
  required: false,
  projection: "mounted",
  mountPath: "manifest.json",
};

const SPEC: InputRequirement = {
  role: "spec",
  artifactKind: "spec",
  required: true,
  projection: "mounted",
  mountPath: "spec.json",
};

const SPEC_OPTIONAL: InputRequirement = {
  ...SPEC,
  required: false,
};

const EXECUTION_PLAN: InputRequirement = {
  role: "execution_plan",
  artifactKind: "execution_plan",
  required: false,
  projection: "mounted",
  mountPath: "execution-plan.json",
};

const RESEARCH: InputRequirement = {
  role: "research",
  artifactKind: "receipt",
  required: true,
  projection: "mounted",
  mountPath: "evidence/receipts/",
};

const RESEARCH_OPTIONAL: InputRequirement = {
  ...RESEARCH,
  required: false,
};

const WIKI_TREE: InputRequirement = {
  role: "wiki_tree",
  artifactKind: "wiki_tree",
  required: true,
  projection: "mounted",
  mountPath: "prior-wiki/",
};

const WIKI_TREE_OPTIONAL: InputRequirement = {
  ...WIKI_TREE,
  required: false,
};

const PRIOR_WIKI: InputRequirement = {
  role: "prior_wiki",
  artifactKind: "wiki_tree",
  required: false,
  projection: "mounted",
  mountPath: "prior-wiki/",
};

const DEFECTS: InputRequirement = {
  role: "defects",
  artifactKind: "receipt",
  required: false,
  projection: "mounted",
  mountPath: "defects.json",
};

const DEFECTS_REQUIRED: InputRequirement = {
  ...DEFECTS,
  required: true,
};

const TRANSCRIPT_AUDIT: InputRequirement = {
  role: "transcript",
  artifactKind: "transcript",
  required: false,
  projection: "audit-only",
};

/** Optional sealed operator answer after gate_requested → ResolveGate(answer). */
const OPERATOR_INPUT: InputRequirement = {
  role: "operator_input",
  artifactKind: "operator_input",
  required: false,
  projection: "mounted",
  mountPath: "operator-input.json",
};

const CONTRACTS: Record<string, NodeContract> = {
  freeze: {
    kind: "freeze",
    requiredInputs: [],
    outputs: [
      { role: "sources", artifactKind: "snapshot_set" },
      { role: "skill", artifactKind: "skill" },
      { role: "frozen_run_manifest", artifactKind: "manifest" },
      // prior_wiki only when intent.mode === refresh (optional output)
      { role: "prior_wiki", artifactKind: "wiki_tree" },
    ],
    execution: "mechanical",
  },
  plan: {
    kind: "plan",
    requiredInputs: [SOURCES, SKILL, FROZEN_MANIFEST, TRANSCRIPT_AUDIT, OPERATOR_INPUT],
    outputs: [
      { role: "spec", artifactKind: "spec" },
      // execution_plan sealed by host after plan success
      { role: "execution_plan", artifactKind: "execution_plan" },
    ],
    execution: "pi",
  },
  "research.leaf": {
    kind: "research.leaf",
    requiredInputs: [
      SOURCES,
      SKILL,
      SPEC_OPTIONAL,
      EXECUTION_PLAN,
      FROZEN_MANIFEST,
      OPERATOR_INPUT,
    ],
    outputs: [{ role: "research", artifactKind: "receipt" }],
    execution: "pi",
  },
  "research.domain": {
    kind: "research.domain",
    requiredInputs: [
      SOURCES,
      SKILL,
      RESEARCH,
      SPEC_OPTIONAL,
      EXECUTION_PLAN,
      FROZEN_MANIFEST,
      OPERATOR_INPUT,
    ],
    outputs: [{ role: "research", artifactKind: "receipt" }],
    execution: "pi",
  },
  "write.root": {
    kind: "write.root",
    requiredInputs: [
      SOURCES,
      SKILL,
      SPEC,
      EXECUTION_PLAN,
      RESEARCH_OPTIONAL,
      PRIOR_WIKI,
      WIKI_TREE_OPTIONAL,
      DEFECTS,
      FROZEN_MANIFEST,
      OPERATOR_INPUT,
    ],
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
    execution: "pi",
  },
  "review.seat": {
    kind: "review.seat",
    // defects optional: present on re-review after repair for priorBlocking differential.
    requiredInputs: [WIKI_TREE, SPEC, SOURCES, SKILL, FROZEN_MANIFEST, DEFECTS, OPERATOR_INPUT],
    outputs: [{ role: "review_seat", artifactKind: "receipt" }],
    execution: "pi",
  },
  "review.reduce": {
    kind: "review.reduce",
    // review_seat is optional at claim time: when acceptance.reviewRequired=false the
    // graph has zero seats, so no seat artifacts are bound. Mechanical reduce still
    // fail-closes when reviewRequired or configured review.seat.* nodes exist without
    // bound seat artifacts (never invents NO_DEFECTS in those cases).
    requiredInputs: [
      WIKI_TREE,
      { role: "review_seat", artifactKind: "receipt", required: false, projection: "handle" },
      SPEC,
    ],
    outputs: [
      { role: "defects", artifactKind: "receipt" },
      { role: "wiki_tree", artifactKind: "wiki_tree" },
    ],
    execution: "mechanical",
  },
  repair: {
    kind: "repair",
    requiredInputs: [WIKI_TREE, SPEC, DEFECTS, SOURCES, SKILL, FROZEN_MANIFEST, OPERATOR_INPUT],
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
    execution: "pi",
  },
  "validate.pre": {
    kind: "validate.pre",
    requiredInputs: [WIKI_TREE, SPEC],
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
    execution: "mechanical",
  },
  "validate.final": {
    kind: "validate.final",
    requiredInputs: [WIKI_TREE, SPEC],
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
    execution: "mechanical",
  },
  "prepare.publication": {
    kind: "prepare.publication",
    requiredInputs: [WIKI_TREE],
    outputs: [{ role: "publication_candidate", artifactKind: "publication_candidate" }],
    execution: "mechanical",
  },
  publish: {
    kind: "publish",
    // Candidate is owned by the durable effect row (gate.publication → publish edge
    // does not re-bind prepare.publication outputs). Validate via effect, not attempt_inputs.
    requiredInputs: [
      {
        role: "publication_candidate",
        artifactKind: "publication_candidate",
        required: false,
        projection: "handle",
      },
    ],
    outputs: [],
    execution: "mechanical",
  },
  "gate.plan": {
    kind: "gate.plan",
    requiredInputs: [SPEC_OPTIONAL],
    outputs: [],
    execution: "gate",
  },
  "gate.fix": {
    kind: "gate.fix",
    requiredInputs: [DEFECTS, WIKI_TREE_OPTIONAL],
    outputs: [],
    execution: "gate",
  },
  "gate.publication": {
    kind: "gate.publication",
    requiredInputs: [
      {
        role: "publication_candidate",
        artifactKind: "publication_candidate",
        required: false,
        projection: "handle",
      },
    ],
    outputs: [],
    execution: "gate",
  },
};

/**
 * Resolve the NodeContract for a node kind/key.
 * Supports repair.review.* / repair.hv.* via kind===repair or repair.* key prefix.
 */
export function contractForNode(kind: string, nodeKey: string): NodeContract {
  if (kind === "repair" || nodeKey.startsWith("repair.")) {
    // repair.review.* prefers defects; repair.hv.* may lack defects (mechanical HV notes in feedback).
    if (nodeKey.startsWith("repair.hv.")) {
      return {
        kind: "repair",
        requiredInputs: [WIKI_TREE, SPEC, SOURCES, SKILL, DEFECTS, FROZEN_MANIFEST],
        outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
        execution: "pi",
      };
    }
    if (nodeKey.startsWith("repair.review.")) {
      return {
        kind: "repair",
        requiredInputs: [WIKI_TREE, SPEC, DEFECTS_REQUIRED, SOURCES, SKILL, FROZEN_MANIFEST],
        outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
        execution: "pi",
      };
    }
    return CONTRACTS.repair!;
  }
  const exact = CONTRACTS[kind];
  if (exact) return exact;
  // Unknown kinds: minimal ambient sources/skill when post-freeze (fail soft — no required extras).
  return {
    kind,
    requiredInputs: [],
    outputs: [],
    execution: "mechanical",
  };
}

/** All registered contracts (tests / diagnostics). */
export function allNodeContracts(): readonly NodeContract[] {
  return Object.values(CONTRACTS);
}
