/**
 * Spec → Run Graph topology (pure). Observation model only — not an executor.
 */

import type { GraphNodeDef, WikiRunSpec } from "@okf-wiki/contract";

/**
 * Build static topology nodes from an approved WikiRunSpec.
 * Node keys match produce-wiki spanIds (domain-{id}, leaf-{id}-{n}, …).
 */
export function topologyFromSpec(spec: WikiRunSpec): GraphNodeDef[] {
  const nodes: GraphNodeDef[] = [{ nodeKey: "plan", kind: "plan", label: "Plan" }];

  const domains = spec.domains ?? [];
  for (const d of domains) {
    const domainKey = `domain-${d.id}`;
    nodes.push({
      nodeKey: domainKey,
      kind: "domain",
      label: d.title?.trim() || d.id,
      parentKey: "plan",
      dependsOn: ["plan"],
    });
    const questions = d.questions ?? [];
    for (let i = 0; i < questions.length; i++) {
      const leafKey = `leaf-${d.id}-${i + 1}`;
      nodes.push({
        nodeKey: leafKey,
        kind: "leaf",
        label: `Leaf ${i + 1}: ${d.id}`,
        parentKey: domainKey,
        dependsOn: [domainKey],
      });
    }
  }

  nodes.push({
    nodeKey: "root_write",
    kind: "write",
    label: "Write wiki",
    dependsOn: domains.length > 0 ? domains.map((d) => `domain-${d.id}`) : ["plan"],
  });
  nodes.push({
    nodeKey: "review",
    kind: "review",
    label: "Review",
    dependsOn: ["root_write"],
  });
  nodes.push({
    nodeKey: "repair",
    kind: "repair",
    label: "Repair",
    dependsOn: ["review"],
  });
  nodes.push({
    nodeKey: "validate",
    kind: "validate",
    label: "Validate",
    dependsOn: ["review"],
  });
  nodes.push({
    nodeKey: "publish",
    kind: "publish",
    label: "Publish",
    dependsOn: ["validate"],
  });

  return nodes;
}
