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
  /** Optional business evidence, required only for the applicable run mode. */
  required?: boolean;
};

export type ProducedArtifact = {
  role: string;
  kind: string;
};

/** Immutable attempt-input envelope retained from the sealed artifact record. */
export type BoundInput = {
  role: string;
  kind: string;
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

/** Whether sealed role+kind envelopes satisfy one InputRequirement. */
export function roleSatisfied(
  requirement: InputRequirement,
  boundInputs: readonly BoundInput[],
): boolean {
  const hit = boundInputs.some(
    (input) =>
      inputRoleMatches(requirement, input.role) &&
      (requirement.artifactKind === undefined || requirement.artifactKind === input.kind),
  );
  return requirement.required ? hit : true;
}

/** Throw if any required role and artifact kind is missing from the sealed input envelope. */
export function validateBoundInputs(
  contract: NodeContract,
  boundInputs: readonly BoundInput[],
): void {
  const missing: string[] = [];
  for (const req of contract.requiredInputs) {
    if (req.required && !roleSatisfied(req, boundInputs)) {
      missing.push(`${req.role}:${req.artifactKind ?? "*"}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `node ${contract.kind} missing required sealed input(s): ${missing.join(", ")} ` +
        `(bound: ${
          boundInputs.length
            ? boundInputs.map((input) => `${input.role}:${input.kind}`).join(", ")
            : "(none)"
        })`,
    );
  }
}

/** Canonical metrics/cost-attribution role for a durable WikiRuns node kind. */
export function metricsRoleForNodeKind(kind: string): string {
  switch (kind) {
    case "plan":
      return "plan";
    case "plan.adapt":
      return "plan_adapt";
    case "research.leaf":
      return "leaf";
    case "research.domain":
      return "domain";
    case "write.root":
      return "writer";
    case "review.seat":
      return "review";
    case "repair":
      return "repair";
    case "freeze":
    case "validate.pre":
    case "validate.final":
    case "review.reduce":
    case "prepare.publication":
    case "publish":
    case "gate.plan":
    case "gate.fix":
    case "gate.publication":
      return "mechanical";
    default:
      if (kind.startsWith("research.leaf")) return "leaf";
      if (kind.startsWith("research.domain")) return "domain";
      if (kind.startsWith("review.seat")) return "review";
      if (kind.startsWith("repair")) return "repair";
      if (kind.startsWith("gate.")) return "mechanical";
      return kind.slice(0, 64) || "unknown";
  }
}

/**
 * Validate business artifacts before a successful attempt is committed. Every
 * required declared output must be present; transcripts are universal audit evidence and
 * intentionally optional so an implementation fault cannot hide a business
 * contract violation behind transcript plumbing.
 */
export function validateNodeOutputs(
  contract: NodeContract,
  outputs: readonly ProducedArtifact[],
): void {
  const duplicateRoles = [...new Set(outputs.map((output) => output.role))].filter(
    (role) => outputs.filter((output) => output.role === role).length > 1,
  );
  if (duplicateRoles.length > 0) {
    throw new Error(
      `node ${contract.kind} produced duplicate output role(s): ${duplicateRoles.join(", ")}`,
    );
  }
  const businessOutputs = outputs.filter(
    (output) => !(output.role === "transcript" && output.kind === "transcript"),
  );
  const missing = contract.outputs.filter(
    (required) =>
      required.required !== false &&
      !businessOutputs.some(
        (output) => output.role === required.role && output.kind === required.artifactKind,
      ),
  );
  if (missing.length > 0) {
    throw new Error(
      `node ${contract.kind} missing declared output(s): ` +
        missing.map((output) => `${output.role}:${output.artifactKind}`).join(", "),
    );
  }
  const unexpected = businessOutputs.filter(
    (output) =>
      !contract.outputs.some(
        (required) => output.role === required.role && output.kind === required.artifactKind,
      ),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `node ${contract.kind} produced undeclared output(s): ` +
        unexpected.map((output) => `${output.role}:${output.kind}`).join(", "),
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

/** Full sealed validation evidence for a mechanically-triggered repair. */
const MECHANICAL_REPORT: InputRequirement = {
  role: "mechanical_report",
  artifactKind: "receipt",
  required: false,
  projection: "mounted",
  mountPath: "mechanical-report.json",
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

const VALIDATE_REPORT_OUTPUT: OutputRequirement = {
  role: "validate_report",
  artifactKind: "receipt",
};

const CONTRACTS: Record<string, NodeContract> = {
  freeze: {
    kind: "freeze",
    requiredInputs: [],
    outputs: [
      { role: "sources", artifactKind: "snapshot_set" },
      { role: "skill", artifactKind: "skill" },
      { role: "frozen_run_manifest", artifactKind: "manifest" },
      { role: "prior_wiki", artifactKind: "wiki_tree", required: false },
      { role: "attempt_output", artifactKind: "manifest" },
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
  "plan.adapt": {
    kind: "plan.adapt",
    requiredInputs: [
      SOURCES,
      SKILL,
      SPEC,
      { ...EXECUTION_PLAN, required: true },
      RESEARCH_OPTIONAL,
      FROZEN_MANIFEST,
      TRANSCRIPT_AUDIT,
      OPERATOR_INPUT,
    ],
    outputs: [{ role: "plan_delta", artifactKind: "receipt" }],
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
      { role: "evaluation_round", artifactKind: "receipt" },
    ],
    execution: "mechanical",
  },
  repair: {
    kind: "repair",
    requiredInputs: [
      WIKI_TREE,
      SPEC,
      DEFECTS,
      MECHANICAL_REPORT,
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
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }, VALIDATE_REPORT_OUTPUT],
    execution: "mechanical",
  },
  "validate.final": {
    kind: "validate.final",
    requiredInputs: [WIKI_TREE, SPEC],
    outputs: [{ role: "wiki_tree", artifactKind: "wiki_tree" }, VALIDATE_REPORT_OUTPUT],
    execution: "mechanical",
  },
  "prepare.publication": {
    kind: "prepare.publication",
    requiredInputs: [WIKI_TREE],
    outputs: [
      { role: "publication_candidate", artifactKind: "publication_candidate" },
      { role: "candidate_meta", artifactKind: "receipt" },
    ],
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
    outputs: [{ role: "publish_receipt", artifactKind: "receipt" }],
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
    case "plan.adapt":
      return /^plan\.adapt\.[1-2]$/.test(nodeKey);
    case "review.seat":
      return /^review\.seat\..+$/.test(nodeKey);
    default:
      return nodeKey === kind;
  }
}

/** Resolve the fixed contract for a valid WikiRuns node kind/key. */
export function contractForNode(kind: string, nodeKey: string): NodeContract {
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
