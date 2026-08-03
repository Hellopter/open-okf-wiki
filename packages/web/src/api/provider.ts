/**
 * Health, doctor, provider catalog, models, and app-settings HTTP API.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type { ModelProfilePublic, ModelProfileWrite, ProviderApiShape, ProviderEntryPublic, ProviderPublic, ProviderTestResult } from "@okf-wiki/contract/workspace";
import { ModelProfilePublicSchema, ProviderApiShapeSchema, ProviderPublicSchema, ProviderTestResultSchema } from "@okf-wiki/contract/workspace";
import { z } from "zod";
import { request } from "./client";

export type {
  ModelProfilePublic,
  ProviderApiShape,
  ProviderEntryPublic,
  ProviderPublic,
  ProviderTestResult,
};

/** Alias kept for existing call sites (create/update model profile body). */
export type ModelProfileWriteInput = Omit<ModelProfileWrite, "baseUrl" | "apiShape"> & {
  /** Optional under provider-first flow — contract defaults apply. */
  baseUrl?: string;
  apiShape?: ProviderApiShape;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  version?: string;
  pid?: number;
};

export type DoctorResponse = {
  ok: boolean;
  node: string;
  platform: string;
  arch: string;
  git: {
    available: boolean;
    version: string | null;
  };
  env: {
    openaiBaseUrlSet: boolean;
    openaiApiKeySet: boolean;
  };
  provider?: {
    configured: boolean;
    modelCount?: number;
    defaultModelProfileId?: string | null;
    baseUrlSet: boolean;
    apiKeySet: boolean;
    apiShape: ProviderApiShape;
    baseUrlSource: "stored" | "env" | "none";
    apiKeySource: "stored" | "env" | "none";
    baseUrlHost: string | null;
  };
};

const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string().optional(),
  pid: z.number().int().optional(),
});

const DoctorResponseSchema = z
  .object({
    ok: z.boolean(),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    git: z.object({ available: z.boolean(), version: z.string().nullable() }),
    env: z.object({ openaiBaseUrlSet: z.boolean(), openaiApiKeySet: z.boolean() }),
    provider: z
      .object({
        configured: z.boolean(),
        modelCount: z.number().int().optional(),
        defaultModelProfileId: z.string().nullable().optional(),
        baseUrlSet: z.boolean(),
        apiKeySet: z.boolean(),
        apiShape: ProviderApiShapeSchema,
        baseUrlSource: z.enum(["stored", "env", "none"]),
        apiKeySource: z.enum(["stored", "env", "none"]),
        baseUrlHost: z.string().nullable(),
      })
      .optional(),
  })
  .transform(
    (response): DoctorResponse => ({
      ok: response.ok,
      node: response.node,
      platform: response.platform,
      arch: response.arch,
      git: {
        available: response.git.available,
        version: response.git.version ?? null,
      },
      env: {
        openaiBaseUrlSet: response.env.openaiBaseUrlSet,
        openaiApiKeySet: response.env.openaiApiKeySet,
      },
      ...(response.provider
        ? {
            provider: {
              configured: response.provider.configured,
              ...(response.provider.modelCount === undefined
                ? {}
                : { modelCount: response.provider.modelCount }),
              ...(response.provider.defaultModelProfileId === undefined
                ? {}
                : { defaultModelProfileId: response.provider.defaultModelProfileId }),
              baseUrlSet: response.provider.baseUrlSet,
              apiKeySet: response.provider.apiKeySet,
              apiShape: response.provider.apiShape,
              baseUrlSource: response.provider.baseUrlSource,
              apiKeySource: response.provider.apiKeySource,
              baseUrlHost: response.provider.baseUrlHost,
            },
          }
        : {}),
    }),
  );

const ProviderResponseSchema = z.object({ provider: ProviderPublicSchema });
const ModelResponseSchema = ProviderResponseSchema.extend({
  model: ModelProfilePublicSchema.optional(),
});
const ProviderTestResponseSchema = z.object({ result: ProviderTestResultSchema });

const AppSettingsSchema = z.object({
  loadHomeSkills: z.boolean(),
  loadHomeSkillsStored: z.boolean().nullable(),
  homeSkillsDir: z.string(),
  homeProducerSkill: z.string(),
  workspaceSkillsRelative: z.string(),
});
const AppSettingsResponseSchema = z.object({ settings: AppSettingsSchema });
const ParsedAppSettingsResponseSchema = AppSettingsResponseSchema.transform(
  (response): { settings: AppSettingsPublic } => ({
    settings: {
      loadHomeSkills: response.settings.loadHomeSkills,
      loadHomeSkillsStored: response.settings.loadHomeSkillsStored ?? null,
      homeSkillsDir: response.settings.homeSkillsDir,
      homeProducerSkill: response.settings.homeProducerSkill,
      workspaceSkillsRelative: response.settings.workspaceSkillsRelative,
    },
  }),
);

export function getHealth(): Promise<HealthResponse> {
  return request("/api/health").then(HealthResponseSchema.parse);
}

export function getDoctor(): Promise<DoctorResponse> {
  return request("/api/doctor").then(DoctorResponseSchema.parse);
}

export function getProvider(): Promise<{ provider: ProviderPublic }> {
  return request("/api/provider").then(ProviderResponseSchema.parse);
}

/** Machine-local app settings (home skills switch; page-editable only). */
export type AppSettingsPublic = {
  loadHomeSkills: boolean;
  loadHomeSkillsStored: boolean | null;
  homeSkillsDir: string;
  homeProducerSkill: string;
  workspaceSkillsRelative: string;
};

export function getAppSettings(): Promise<{ settings: AppSettingsPublic }> {
  return request("/api/app-settings").then(ParsedAppSettingsResponseSchema.parse);
}

export function patchAppSettings(input: {
  loadHomeSkills: boolean;
}): Promise<{ settings: AppSettingsPublic }> {
  return request("/api/app-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then(ParsedAppSettingsResponseSchema.parse);
}

export function createModelProfile(
  input: ModelProfileWriteInput,
): Promise<{ provider: ProviderPublic; model?: ModelProfilePublic }> {
  return request("/api/provider/models", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(ModelResponseSchema.parse);
}

export function updateModelProfile(
  profileId: string,
  input: ModelProfileWriteInput,
): Promise<{ provider: ProviderPublic; model?: ModelProfilePublic }> {
  return request(`/api/provider/models/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then(ModelResponseSchema.parse);
}

export function deleteModelProfile(profileId: string): Promise<{ provider: ProviderPublic }> {
  return request(`/api/provider/models/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  }).then(ProviderResponseSchema.parse);
}

export function setDefaultModelProfile(
  defaultModelProfileId: string | null,
): Promise<{ provider: ProviderPublic }> {
  return request("/api/provider/default", {
    method: "PUT",
    body: JSON.stringify({ defaultModelProfileId }),
  }).then(ProviderResponseSchema.parse);
}

export type ProviderEntryWriteInput = {
  name: string;
  baseUrl?: string;
  apiKey?: string | null;
  apiShape?: ProviderApiShape;
  headers?: Record<string, string> | null;
  supportsDeveloperRole?: boolean;
};

export function createProvider(
  input: ProviderEntryWriteInput,
): Promise<{ provider: ProviderPublic }> {
  return request("/api/provider/providers", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(ProviderResponseSchema.parse);
}

export function updateProvider(
  providerId: string,
  input: ProviderEntryWriteInput,
): Promise<{ provider: ProviderPublic }> {
  return request(`/api/provider/providers/${encodeURIComponent(providerId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then(ProviderResponseSchema.parse);
}

export function deleteProvider(providerId: string): Promise<{ provider: ProviderPublic }> {
  return request(`/api/provider/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  }).then(ProviderResponseSchema.parse);
}

export function testProvider(input?: {
  modelProfileId?: string;
  baseUrl?: string;
  apiKey?: string;
  apiShape?: ProviderApiShape;
  modelId?: string;
  headers?: Record<string, string>;
}): Promise<{ result: ProviderTestResult }> {
  return request("/api/provider/test", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }).then(ProviderTestResponseSchema.parse);
}
