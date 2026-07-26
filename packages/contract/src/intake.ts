import { z } from "zod";
import {
  OperatorToolsSchema,
  SourceIdSchema,
  WikiLanguageSchema,
  WorkspaceLimitsSchema,
  WorkspaceOrchestrationSchema,
  WorkspaceRoleModelsSchema,
  WorkspaceSourceSchema,
} from "./workspace.js";

/**
 * HTTP body: create workspace.
 * Model selection comes from the provider catalog (`modelProfileId`); the
 * server resolves the denormalized model ref. Other workspace settings are
 * configured via PATCH after creation.
 */
export const WorkspaceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    rootPath: z.string().trim().min(1),
    publicationPath: z.string().trim().min(1).optional(),
    modelProfileId: z.string().trim().min(1).optional(),
  })
  .strict();

export type WorkspaceCreate = z.infer<typeof WorkspaceCreateSchema>;

/** HTTP body: patch workspace (partial). rootPath and id are immutable. */
export const WorkspacePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Catalog model profile id; the server resolves the denormalized ref. */
    modelProfileId: z.string().trim().min(1).optional(),
    /** Alternative selection carrier: `{ profileId }` (same resolution). */
    model: z.object({ profileId: z.string().trim().min(1) }).optional(),
    publicationPath: z.string().trim().min(1).optional(),
    planConfirm: z.boolean().optional(),
    wikiLanguage: WikiLanguageSchema.optional(),
    limits: WorkspaceLimitsSchema.optional(),
    roleModels: WorkspaceRoleModelsSchema.optional(),
    orchestration: WorkspaceOrchestrationSchema.optional(),
    operatorTools: OperatorToolsSchema.optional(),
    skillPath: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export type WorkspacePatch = z.infer<typeof WorkspacePatchSchema>;

/** HTTP body: add existing local path as source. */
export const SourceAddSchema = z.object({
  id: SourceIdSchema.optional(),
  path: z.string().trim().min(1),
  applyDefaultIgnores: z.boolean().optional(),
  ignore: z.array(z.string()).optional(),
});

export type SourceAdd = z.infer<typeof SourceAddSchema>;

/** HTTP body: clone remote into workspace sources. */
export const SourceCloneSchema = z.object({
  id: SourceIdSchema.optional(),
  remoteUrl: z.string().trim().min(1).max(2000),
  ref: z.string().trim().min(1).max(200).optional(),
  applyDefaultIgnores: z.boolean().optional(),
  ignore: z.array(z.string()).optional(),
});

export type SourceClone = z.infer<typeof SourceCloneSchema>;

/** Re-export source shape for intake consumers. */
export { WorkspaceSourceSchema };
