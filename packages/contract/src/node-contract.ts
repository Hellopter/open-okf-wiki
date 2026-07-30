/**
 * Finite WikiRuns NodeContract registry.
 *
 * This is the single fixed projection table shared by WikiRuns input binding
 * and Pi Attempt materialization. It is deliberately not a user-editable DSL.
 */

export type ProjectionMode = "inline" | "mounted" | "handle" | "audit-only";

export type InputRequirement = {
  /** Logical role; "research" matches exact or namespaced `*:research`. */
  role: string;
  artifactKind?: string;
  required: boolean;
  projection: ProjectionMode;
  /** Relative path under Attempt workDir/inputs when projection is mounted. */
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

/** Whether one sealed role matches an input requirement. */
export function inputRoleMatches(requirement: InputRequirement, boundRole: string): boolean {
  if (requirement.role === boundRole) return true;
  if (requirement.role === "research") return isResearchRole(boundRole);
  if (requirement.role === "review_seat") return isReviewSeatRole(boundRole);
  return boundRole.endsWith(`:${requirement.role}`);
}

/** Whether bound roles satisfy one InputRequirement (at least one match when required). */
export function roleSatisfied(
  requirement: InputRequirement,
  boundRoles: readonly string[],
): boolean {
  const hit = boundRoles.some((role) => inputRoleMatches(requirement, role));
  return requirement.required ? hit : true;
}

/** Throw if any required input role is missing from the bound attempt envelope. */
export function validateBoundInputs(contract: NodeContract, boundRoles: readonly string[]): void {
  const missing: string[] = [];
  for (const req of contract.requiredInputs) {
    if (req.required && !roleSatisfied(req, boundRoles)) missing.push(req.role);
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
  mountPath: "../sources/",
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
  required: true,
  projection: "mounted",
  mountPath: "frozen-run-manifest.json",
};

const SPEC: InputRequirement = {
  role: "spec",
  artifactKind: "spec",
  required: true,
  projection: "mounted",
  mountPath: "spec.json",
};

const SPEC_OPTIONAL: InputRequirement = { ...SPEC, required: false };

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

const RESEARCH_OPTIONAL: InputRequirement = { ...RESEARCH, required: false };

const WIKI_TREE: InputRequirement = {
  role: "wiki_tree",
  artifactKind: "wiki_tree",
  required: true,
  projection: "mounted",
  mountPath: "prior-wiki/",
};

const WIKI_TREE_OPTIONAL: InputRequirement = { ...WIKI_TREE, required: false };

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

const TRANSCRIPT_AUDIT: InputRequirement = {
  role: "transcript",
  artifactKind: "transcript",
  required: false,
  projection: "audit-only",
};

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
      { role: "prior_wiki", artifactKind: "wiki_tree" },
    ],
    execution: "mechanical",
  },
  plan: {
    kind: "plan",
    requiredInputs: [SOURCES, SKILL, FROZEN_MANIFEST, TRANSCRIPT_AUDIT, OPERATOR_INPUT],
    outputs: [
      { role: "spec", artifactKind: "spec" },
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
      { ...EXECUTION_PLAN, required: true },
      FROZEN_MANIFEST,
      TRANSCRIPT_AUDIT,
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
      { ...EXECUTION_PLAN, required: true },
      FROZEN_MANIFEST,
      TRANSCRIPT_AUDIT,
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
      { ...EXECUTION_PLAN, required: true },
      RESEARCH_OPTIONAL,
      PRIOR_WIKI,
      WIKI_TREE_OPTIONAL,
      DEFECTS,
      FROZEN_MANIFEST,
      TRANSCRIPT_AUDIT,
      OPERATOR_INPUT,
    ],
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
    execution: "pi",
  },
  "review.seat": {
    kind: "review.seat",
    requiredInputs: [
      WIKI_TREE,
      SPEC,
      SOURCES,
      SKILL,
      FROZEN_MANIFEST,
      TRANSCRIPT_AUDIT,
      DEFECTS,
      OPERATOR_INPUT,
    ],
    outputs: [{ role: "review_seat", artifactKind: "receipt" }],
    execution: "pi",
  },
  "review.reduce": {
    kind: "review.reduce",
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
    requiredInputs: [
      WIKI_TREE,
      SPEC,
      DEFECTS,
      SOURCES,
      SKILL,
      FROZEN_MANIFEST,
      TRANSCRIPT_AUDIT,
      OPERATOR_INPUT,
    ],
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

function hasValidKey(kind: string, nodeKey: string): boolean {
  switch (kind) {
    case "repair":
      return /^repair\.[1-9]\d*$/.test(nodeKey);
    case "research.leaf":
      return /^research\.leaf\..+\.\d+$/.test(nodeKey);
    case "research.domain":
      return /^research\.domain\..+$/.test(nodeKey);
    case "review.seat":
      return /^review\.seat\..+$/.test(nodeKey);
    default:
      return nodeKey === kind;
  }
}

/** Resolve the fixed contract for a valid WikiRuns node kind/key. */
export function contractForNode(kind: string, nodeKey: string): NodeContract {
  if (kind === "repair") {
    if (!hasValidKey(kind, nodeKey)) {
      throw new Error(`unknown WikiRuns node key for repair: ${nodeKey}`);
    }
    return {
      kind: "repair",
      requiredInputs: [
        WIKI_TREE,
        SPEC,
        SOURCES,
        SKILL,
        DEFECTS,
        FROZEN_MANIFEST,
        TRANSCRIPT_AUDIT,
        OPERATOR_INPUT,
      ],
      outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }],
      execution: "pi",
    };
  }
  const exact = CONTRACTS[kind];
  if (!exact) throw new Error(`unknown WikiRuns node kind: ${kind}`);
  if (!hasValidKey(kind, nodeKey)) {
    throw new Error(`unknown WikiRuns node key for ${kind}: ${nodeKey}`);
  }
  return exact;
}

/** All registered contracts (tests / diagnostics). */
export function allNodeContracts(): readonly NodeContract[] {
  return Object.values(CONTRACTS);
}
