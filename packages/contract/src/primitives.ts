import { z } from "zod";

/** Lowercase hex SHA-256 digest (64 chars). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Git object id: SHA-1 (40) or SHA-256 (64) lowercase hex. */
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export type Sha256Hex = z.infer<typeof Sha256HexSchema>;
export type GitObjectId = z.infer<typeof GitObjectIdSchema>;
