import { z } from "zod";
import {
  OperatorToolsSchema,
  SourceIdSchema,
  WikiLanguageSchema,
  WorkspaceLimitsPatchSchema,
  WorkspaceOrchestrationSchema,
  WorkspaceRevisionSchema,
  WorkspaceRoleModelsSchema,
  WorkspaceSourceSchema,
} from "./workspace.js";

/**
 * HTTP body: create workspace.
 * Model selection comes from the provider catalog (`modelProfileId`); the
 * server resolves the denormalized model ref. Run capacity is selected at
 * creation time because v3 never infers a scheduler ceiling.
 */
export const WorkspaceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    rootPath: z.string().trim().min(1),
    publicationPath: z.string().trim().min(1).optional(),
    modelProfileId: z.string().trim().min(1).optional(),
    orchestration: WorkspaceOrchestrationSchema,
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
    /** Partial limits; server deep-merges onto existing then re-parses. */
    limits: WorkspaceLimitsPatchSchema.optional(),
    roleModels: WorkspaceRoleModelsSchema.optional(),
    orchestration: WorkspaceOrchestrationSchema.optional(),
    operatorTools: OperatorToolsSchema.optional(),
    skillPath: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export type WorkspacePatch = z.infer<typeof WorkspacePatchSchema>;

/** HTTP wrapper for a Workspace patch with its optimistic concurrency token. */
export const WorkspacePatchRequestSchema = WorkspacePatchSchema.extend({
  expectedRevision: WorkspaceRevisionSchema,
}).strict();

export type WorkspacePatchRequest = z.infer<typeof WorkspacePatchRequestSchema>;

/** HTTP body: add existing local path as source. */
export const SourceAddSchema = z
  .object({
    expectedRevision: WorkspaceRevisionSchema,
    id: SourceIdSchema.optional(),
    path: z.string().trim().min(1),
    applyDefaultIgnores: z.boolean().optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

export type SourceAdd = z.infer<typeof SourceAddSchema>;

/** HTTP body: clone remote into workspace sources. */
export const SourceCloneSchema = z
  .object({
    expectedRevision: WorkspaceRevisionSchema,
    id: SourceIdSchema.optional(),
    remoteUrl: z.string().trim().min(1).max(2000),
    /** Workspace-relative destination directory for a cloned source. */
    relativeDir: z.string().trim().min(1).max(500).optional(),
    ref: z.string().trim().min(1).max(200).optional(),
    applyDefaultIgnores: z.boolean().optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

export type SourceClone = z.infer<typeof SourceCloneSchema>;

/** HTTP body: update source ignore policy (path and id are immutable). */
export const SourceUpdateSchema = z
  .object({
    expectedRevision: WorkspaceRevisionSchema,
    applyDefaultIgnores: z.boolean().optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict()
  .refine((body) => body.applyDefaultIgnores !== undefined || body.ignore !== undefined, {
    message: "provide applyDefaultIgnores and/or ignore",
  });

export type SourceUpdate = z.infer<typeof SourceUpdateSchema>;

/** Version token required by write routes whose only change is server-side state. */
export const WorkspaceRevisionRequestSchema = z
  .object({ expectedRevision: WorkspaceRevisionSchema })
  .strict();

export type WorkspaceRevisionRequest = z.infer<typeof WorkspaceRevisionRequestSchema>;

/** Strict HTTP body for writing one file in the active editable Skill Fork. */
export const WorkspaceSkillFileWriteSchema = z
  .object({
    expectedRevision: WorkspaceRevisionSchema,
    path: z.string().trim().min(1).max(1000),
    content: z.string(),
  })
  .strict();

export type WorkspaceSkillFileWrite = z.infer<typeof WorkspaceSkillFileWriteSchema>;

/** Re-export source shape for intake consumers. */
export { WorkspaceSourceSchema };
