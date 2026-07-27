/**
 * Persist / load merged defects.json (council write path + publishability read).
 * I/O only — pure merge/parse lives in defects.ts.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type MergedDefectReport, MergedDefectReportSchema } from "@okf-wiki/contract";
import { defectsPath } from "../ports/core-spec-store.js";

export async function writeMergedDefects(
  workspaceRoot: string,
  runId: string,
  report: MergedDefectReport,
): Promise<string> {
  const parsed = MergedDefectReportSchema.parse(report);
  const filePath = defectsPath(workspaceRoot, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return filePath;
}

export async function readMergedDefects(
  workspaceRoot: string,
  runId: string,
): Promise<MergedDefectReport | null> {
  try {
    const raw = await readFile(defectsPath(workspaceRoot, runId), "utf8");
    return MergedDefectReportSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
