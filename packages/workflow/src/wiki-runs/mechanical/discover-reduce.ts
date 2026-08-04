/**
 * Mechanical plan.discover.reduce: merge sealed plan.scout receipts → discovery_map.
 *
 * Pre-plan stage only (host materializes after freeze when scouts are selected).
 * Fail-closed: missing/malformed receipts → attempt failed.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { DiscoveryMapSchema } from "@okf-wiki/contract/wiki-runs";
import type { WikiRunsControl } from "../ctx.js";
import {
  DISCOVERY_MAP_FILE,
  mergeScoutReceiptsToDiscoveryMap,
} from "../discovery-map-merge.js";
import { asRows, requiredText } from "../sql.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { mechanicalFailed } from "./failed.js";

async function readReceiptJson(root: string): Promise<unknown | undefined> {
  const candidates = [path.join(root, "receipt.json"), root];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.json$/i.test(entry.name) && !entry.name.endsWith(".jsonl")) {
        candidates.unshift(path.join(root, entry.name));
      }
    }
  } catch {
    // root may be a bare file
  }
  for (const candidate of candidates) {
    try {
      const text = (await readFile(candidate, "utf8")).trim();
      if (!text || !text.startsWith("{")) continue;
      return JSON.parse(text) as unknown;
    } catch {
      // next
    }
  }
  try {
    return JSON.parse((await readFile(root, "utf8")).trim()) as unknown;
  } catch {
    return undefined;
  }
}

function nodeKeyFromRole(role: string): string | undefined {
  if (role.endsWith(":scout_receipt")) {
    return role.slice(0, -":scout_receipt".length) || undefined;
  }
  if (role.startsWith("plan.scout.")) return role;
  return undefined;
}

export async function mechanicalDiscoverReduce(
  host: WikiRunsControl,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
): Promise<PiAttemptOutcome> {
  if (claim.kind !== "plan.discover.reduce") {
    return mechanicalFailed({
      claim,
      runDir,
      error: `mechanicalDiscoverReduce called for kind ${claim.kind}`,
      failureClass: "infrastructure",
    });
  }

  const receiptRows = asRows(
    host.db
      .prepare(
        `SELECT attempt_inputs.role, artifacts.relative_path
         FROM attempt_inputs
         JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
         WHERE attempt_inputs.attempt_id = ?
           AND (
             attempt_inputs.role = 'scout_receipt'
             OR attempt_inputs.role LIKE '%:scout_receipt'
           )
         ORDER BY attempt_inputs.role`,
      )
      .all(claim.attemptId),
  );

  if (receiptRows.length === 0) {
    return mechanicalFailed({
      claim,
      runDir,
      error:
        "plan.discover.reduce: no scout_receipt inputs bound (fail-closed; expected plan.scout.* upstreams)",
      failureClass: "schema",
    });
  }

  const receipts: Array<{ raw: unknown; nodeKey?: string; fileName?: string }> = [];
  const errors: string[] = [];

  for (const row of receiptRows) {
    const role = requiredText(row, "role");
    const root = path.join(runDir, requiredText(row, "relative_path"));
    const raw = await readReceiptJson(root);
    if (raw === undefined) {
      errors.push(`${role}: unreadable scout receipt artifact`);
      continue;
    }
    // Soft-fail critical empty: if receipt says critical+!ok, fail reduce.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const body = raw as { critical?: unknown; ok?: unknown };
      if (body.critical === true && body.ok === false) {
        errors.push(`${role}: critical scout reported ok:false`);
        continue;
      }
    }
    receipts.push({
      raw,
      nodeKey: nodeKeyFromRole(role),
      fileName: path.basename(root),
    });
  }

  if (errors.length > 0) {
    return mechanicalFailed({
      claim,
      runDir,
      error: `plan.discover.reduce: ${errors.length} invalid scout receipt(s): ${errors
        .slice(0, 4)
        .join("; ")}`.slice(0, 4_000),
      failureClass: "schema",
    });
  }

  const { map: merged, errors: mergeErrors } = mergeScoutReceiptsToDiscoveryMap(receipts);
  if (mergeErrors.length > 0 && receipts.length === 0) {
    return mechanicalFailed({
      claim,
      runDir,
      error: `plan.discover.reduce: merge failed: ${mergeErrors.slice(0, 4).join("; ")}`.slice(
        0,
        4_000,
      ),
      failureClass: "schema",
    });
  }

  const map = DiscoveryMapSchema.parse(merged);
  const mapPath = path.join(workDir, DISCOVERY_MAP_FILE);
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");

  const summary = `Discovery map: ${map.sources.length} source(s), ${map.domains.length} domain(s), ${map.flows.length} flow(s), ${map.scoutKinds.length} scout kind(s)`;

  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary,
    meta: {
      mode: "plan.discover.reduce",
      sourceCount: map.sources.length,
      domainCount: map.domains.length,
      flowCount: map.flows.length,
      scoutKinds: map.scoutKinds,
      openQuestions: map.openQuestions.length,
    },
  });

  return {
    type: "succeeded",
    unsealedArtifacts: [
      {
        kind: "receipt",
        role: "discovery_map",
        sourcePath: mapPath,
        directory: false,
        summary,
      },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary,
    metrics: { role: "mechanical" },
  };
}
