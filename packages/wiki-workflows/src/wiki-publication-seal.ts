import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { WikiSpec } from "./wiki-spec.js";
import { parseWikiSpec, wikiSpecPagePaths } from "./wiki-spec.js";
import { sameStringSet, stableStringify } from "./util.js";

const sealBrand: unique symbol = Symbol("WikiPublicationSeal");

export interface VerifiedWikiPublicationSealPayload {
  readonly runId: string;
  readonly executionToken: string;
  readonly candidateRoot: string;
  readonly finalTreeDigest: string;
  readonly pages: readonly string[];
  readonly spec: WikiSpec;
}

/** Opaque, run-bound proof that Lead governance and deterministic finalization completed. */
export type WikiPublicationSeal = VerifiedWikiPublicationSealPayload & {
  readonly [sealBrand]: true;
};

/** Package-internal issuer. The Lead run is the only caller allowed to mint a seal. */
export async function issueWikiPublicationSeal(input: {
  runId: string;
  executionToken: string;
  candidateRoot: string;
  pages: readonly string[];
  spec: WikiSpec;
}): Promise<WikiPublicationSeal> {
  const candidateRoot = path.resolve(input.candidateRoot);
  if (typeof input.executionToken !== "string" || !input.executionToken.trim()) throw new Error("Invalid Wiki publication seal execution token");
  const spec = parseWikiSpec(input.spec);
  const pages = [...input.pages];
  if (!sameStringSet(pages, wikiSpecPagePaths(spec))) throw new Error("Publication seal pages do not match the WikiSpec");
  const payload = {
    runId: input.runId,
    executionToken: input.executionToken,
    candidateRoot,
    finalTreeDigest: await digestWikiTree(candidateRoot),
    pages: Object.freeze(pages),
    spec: deepFreeze(structuredClone(spec)),
  };
  return Object.freeze({ ...payload, [sealBrand]: true }) as WikiPublicationSeal;
}

/** Re-prove the candidate immediately before publication and return trusted metadata. */
export async function verifyWikiPublicationSeal(seal: WikiPublicationSeal): Promise<VerifiedWikiPublicationSealPayload> {
  if (!seal || typeof seal !== "object" || seal[sealBrand] !== true) throw new Error("Invalid Wiki publication seal");
  const candidateRoot = path.resolve(seal.candidateRoot);
  if (candidateRoot !== seal.candidateRoot) throw new Error("Wiki publication seal candidate root is not canonical");
  const spec = parseWikiSpec(seal.spec);
  if (!seal.executionToken || typeof seal.executionToken !== "string") throw new Error("Invalid Wiki publication seal execution token");
  if (!sameStringSet(seal.pages, wikiSpecPagePaths(spec))) throw new Error("Wiki publication seal pages no longer match its WikiSpec");
  const actual = await digestWikiTree(candidateRoot);
  if (actual !== seal.finalTreeDigest) throw new Error("Candidate Wiki changed after it was sealed for publication");
  return Object.freeze({
    runId: seal.runId,
    executionToken: seal.executionToken,
    candidateRoot,
    finalTreeDigest: seal.finalTreeDigest,
    pages: Object.freeze([...seal.pages]),
    spec: deepFreeze(structuredClone(spec)),
  });
}

export async function digestWikiTree(root: string): Promise<string> {
  const entries: Array<{ path: string; type: "directory" } | { path: string; type: "file"; digest: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Candidate Wiki contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        await visit(absolute);
      }
      else if (entry.isFile()) entries.push({
        path: relative,
        type: "file",
        digest: createHash("sha256").update(await readFile(absolute)).digest("hex"),
      });
      else throw new Error(`Candidate Wiki contains a non-regular entry: ${absolute}`);
    }
  };
  await visit(path.resolve(root));
  return createHash("sha256").update(stableStringify(entries)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
