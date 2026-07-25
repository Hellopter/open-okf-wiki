import { z } from "zod";
import {
  ModelRefSchema,
  SourceIdSchema,
  WikiLanguageSchema,
  WorkspaceLimitsSchema,
  WorkspaceOrchestrationSchema,
  WorkspaceRoleModelsSchema,
  WorkspaceSourceSchema,
} from "./workspace.js";

/** HTTP body: create workspace. */
export const WorkspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  rootPath: z.string().trim().min(1),
  wikiLanguage: WikiLanguageSchema.optional(),
  model: ModelRefSchema.optional(),
  limits: WorkspaceLimitsSchema.optional(),
  roleModels: WorkspaceRoleModelsSchema.optional(),
  orchestration: WorkspaceOrchestrationSchema.optional(),
  skillPath: z.string().trim().min(1).optional(),
});

export type WorkspaceCreate = z.infer<typeof WorkspaceCreateSchema>;

/** HTTP body: patch workspace (partial). */
export const WorkspacePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    wikiLanguage: WikiLanguageSchema.optional(),
    model: ModelRefSchema.optional(),
    limits: WorkspaceLimitsSchema.optional(),
    roleModels: WorkspaceRoleModelsSchema.optional(),
    orchestration: WorkspaceOrchestrationSchema.optional(),
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
