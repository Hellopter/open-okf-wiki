/**
 * One-line label for run-graph chips / attempt rows.
 * Full receipts stay in the inspector — never dump markdown walls into the grid.
 */

export function compactSummary(raw: string | null | undefined, max = 72): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  // Prefer first non-empty, non-heading-only line after stripping markdown noise.
  const lines = text.split("\n");
  for (const line of lines) {
    let s = line.trim();
    if (!s) continue;
    s = s
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\*?|\*\*?$/g, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!s || s === "---" || s.startsWith("|")) continue;
    if (s.length > max) return `${s.slice(0, Math.max(1, max - 1))}…`;
    return s;
  }

  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) return `${text.slice(0, Math.max(1, max - 1))}…`;
  return text;
}
