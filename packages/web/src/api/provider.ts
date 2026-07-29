/**
 * Health, doctor, provider catalog, models, and app-settings HTTP API.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  ModelProfilePublic,
  ModelProfileWrite,
  ProviderApiShape,
  ProviderEntryPublic,
  ProviderPublic,
  ProviderTestResult,
} from "@okf-wiki/contract";
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

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export function getDoctor(): Promise<DoctorResponse> {
  return request<DoctorResponse>("/api/doctor");
}

export function getProvider(): Promise<{ provider: ProviderPublic }> {
  return request<{ provider: ProviderPublic }>("/api/provider");
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
  return request<{ settings: AppSettingsPublic }>("/api/app-settings");
}

export function patchAppSettings(input: {
  loadHomeSkills: boolean;
}): Promise<{ settings: AppSettingsPublic }> {
  return request<{ settings: AppSettingsPublic }>("/api/app-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createModelProfile(
  input: ModelProfileWriteInput,
): Promise<{ provider: ProviderPublic; model?: ModelProfilePublic }> {
  return request("/api/provider/models", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateModelProfile(
  profileId: string,
  input: ModelProfileWriteInput,
): Promise<{ provider: ProviderPublic; model?: ModelProfilePublic }> {
  return request(`/api/provider/models/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteModelProfile(profileId: string): Promise<{ provider: ProviderPublic }> {
  return request(`/api/provider/models/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
}

export function setDefaultModelProfile(
  defaultModelProfileId: string | null,
): Promise<{ provider: ProviderPublic }> {
  return request("/api/provider/default", {
    method: "PUT",
    body: JSON.stringify({ defaultModelProfileId }),
  });
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
  return request<{ provider: ProviderPublic }>("/api/provider/providers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProvider(
  providerId: string,
  input: ProviderEntryWriteInput,
): Promise<{ provider: ProviderPublic }> {
  return request<{ provider: ProviderPublic }>(
    `/api/provider/providers/${encodeURIComponent(providerId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteProvider(providerId: string): Promise<{ provider: ProviderPublic }> {
  return request<{ provider: ProviderPublic }>(
    `/api/provider/providers/${encodeURIComponent(providerId)}`,
    { method: "DELETE" },
  );
}

export function testProvider(input?: {
  modelProfileId?: string;
  baseUrl?: string;
  apiKey?: string;
  apiShape?: ProviderApiShape;
  modelId?: string;
  headers?: Record<string, string>;
}): Promise<{ result: ProviderTestResult }> {
  return request<{ result: ProviderTestResult }>("/api/provider/test", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}
