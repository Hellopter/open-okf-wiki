/**
 * Operator-facing labels and parent keys for WikiRuns nodes (ADR 0035 projection).
 * Pure helpers used by buildSnapshot — not durable control identifiers.
 */

import type { WikiRunNodeDetail, WikiRunNodeKind } from "@okf-wiki/contract/wiki-runs";

const LABEL_MAX = 200;
const QUESTION_LABEL_MAX = 72;

function clip(text: string, max: number): string {
  const t = text.trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

/** Stable English labels for mechanical / fixed control nodes. */
export function mechanicalLabel(kind: WikiRunNodeKind, key: string): string {
  switch (kind) {
    case "freeze":
      return "Freeze";
    case "plan":
      return "Plan";
    case "gate.plan":
      return "Plan gate";
    case "write.root":
      return "Write";
    case "validate.pre":
      return "Validate (pre)";
    case "validate.final":
      return "Validate (final)";
    case "review.reduce":
      return "Review reduce";
    case "gate.fix":
      return "Fix gate";
    case "repair":
      return "Repair";
    case "prepare.publication":
      return "Prepare publication";
    case "gate.publication":
      return "Publication gate";
    case "publish":
      return "Publish";
    case "research.domain":
    case "research.leaf":
    case "review.seat":
      break;
    default:
      break;
  }
  const short = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  return clip(short || key, LABEL_MAX) || key;
}

/**
 * Project a human-readable chip label from kind + optional sealed detail.
 */
export function labelForNode(
  kind: WikiRunNodeKind,
  key: string,
  detail?: WikiRunNodeDetail | null,
): string {
  if (kind === "research.domain") {
    const title = detail?.title?.trim() || detail?.domainId?.trim();
    if (title) return clip(title, LABEL_MAX);
    const id = key.startsWith("research.domain.") ? key.slice("research.domain.".length) : key;
    return clip(id, LABEL_MAX) || key;
  }
  if (kind === "research.leaf") {
    const q = detail?.question?.trim();
    if (q) return clip(q, QUESTION_LABEL_MAX);
    const domainId = detail?.domainId?.trim();
    const index = detail?.questionIndex;
    if (domainId && index != null) return clip(`L${index}: ${domainId}`, LABEL_MAX);
    if (domainId) return clip(`Leaf: ${domainId}`, LABEL_MAX);
    return mechanicalLabel(kind, key);
  }
  if (kind === "review.seat") {
    const lens = detail?.lens?.trim();
    if (lens) return clip(`Review · ${lens}`, LABEL_MAX);
    const short = key.startsWith("review.seat.") ? key.slice("review.seat.".length) : key;
    return clip(`Review · ${short}`, LABEL_MAX);
  }
  return mechanicalLabel(kind, key);
}

/**
 * Parent key for hierarchy tooltips. Prefer detail.domainId for research leaves.
 */
export function parentKeyForNode(
  kind: WikiRunNodeKind,
  key: string,
  detail?: WikiRunNodeDetail | null,
  edgeParent?: string | null,
): string | undefined {
  if (edgeParent && edgeParent !== key) return edgeParent;
  if (kind === "research.leaf") {
    const domainId = detail?.domainId?.trim();
    if (domainId) return `research.domain.${domainId}`;
  }
  if (kind === "research.domain") return "plan";
  if (kind === "review.seat") return "validate.pre";
  if (kind === "gate.plan") return "plan";
  if (kind === "gate.fix") return "review.reduce";
  if (kind === "gate.publication") return "prepare.publication";
  return undefined;
}

/** Parse detail_json into a narrow WikiRunNodeDetail (drop unknown keys). */
export function parseNodeDetail(raw: unknown): WikiRunNodeDetail | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const out: WikiRunNodeDetail = {};
  if (typeof row.domainId === "string" && row.domainId.trim())
    out.domainId = row.domainId.trim().slice(0, 200);
  if (typeof row.title === "string" && row.title.trim()) out.title = row.title.trim().slice(0, 500);
  if (typeof row.question === "string" && row.question.trim())
    out.question = row.question.trim().slice(0, 4_000);
  if (
    typeof row.questionIndex === "number" &&
    Number.isInteger(row.questionIndex) &&
    row.questionIndex > 0
  )
    out.questionIndex = row.questionIndex;
  if (typeof row.scope === "string" && row.scope.trim())
    out.scope = row.scope.trim().slice(0, 2_000);
  if (typeof row.lens === "string" && row.lens.trim()) out.lens = row.lens.trim().slice(0, 100);
  if (typeof row.critical === "boolean") out.critical = row.critical;
  if (typeof row.workUnitId === "string" && row.workUnitId.trim())
    out.workUnitId = row.workUnitId.trim().slice(0, 120);
  if (
    typeof row.adaptRound === "number" &&
    Number.isInteger(row.adaptRound) &&
    row.adaptRound >= 1 &&
    row.adaptRound <= 2
  )
    out.adaptRound = row.adaptRound;
  return Object.keys(out).length > 0 ? out : undefined;
}
