import type { ModelProfile, ModelProfilePublic, ProviderConfig, ProviderEntry, ProviderEntryPublic, ProviderPublic } from "@okf-wiki/contract/workspace";
import { PROVIDER_CONFIG_VERSION } from "./provider-catalog.js";
import { flattenModels, PROVIDER_KIND } from "./provider-runtime.js";

/** Mask a secret for UI display (never full value). */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "••••••••";
  }
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

export function toModelProfilePublic(
  profile: ModelProfile,
  providerName?: string,
): ModelProfilePublic {
  const apiKey = profile.apiKey?.trim() ?? "";
  return {
    id: profile.id,
    name: profile.name,
    providerKind: PROVIDER_KIND,
    ...(profile.providerId ? { providerId: profile.providerId } : {}),
    ...(providerName ? { providerName } : {}),
    modelId: profile.modelId,
    baseUrl: profile.baseUrl?.trim() ?? "",
    apiKeySet: apiKey.length > 0,
    apiKeyMasked: maskSecret(apiKey),
    apiShape: profile.apiShape ?? "completions",
    ...(profile.maxContextTokens !== undefined
      ? { maxContextTokens: profile.maxContextTokens }
      : {}),
    ...(profile.headers ? { headers: profile.headers } : {}),
    supportsDeveloperRole: profile.supportsDeveloperRole === true,
  };
}

export function toProviderEntryPublic(p: ProviderEntry): ProviderEntryPublic {
  const apiKey = p.apiKey?.trim() ?? "";
  return {
    id: p.id,
    name: p.name,
    kind: PROVIDER_KIND,
    baseUrl: p.baseUrl?.trim() ?? "",
    apiKeySet: apiKey.length > 0,
    apiKeyMasked: maskSecret(apiKey),
    apiShape: p.apiShape ?? "completions",
    ...(p.headers ? { headers: p.headers } : {}),
    supportsDeveloperRole: p.supportsDeveloperRole === true,
    models: (p.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      modelId: m.modelId,
      ...(m.maxContextTokens !== undefined ? { maxContextTokens: m.maxContextTokens } : {}),
      ...(m.headers ? { headers: m.headers } : {}),
    })),
  };
}

/** Public, non-secret catalog for GET /api/provider. */
export function toProviderPublic(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPublic {
  const flat = flattenModels(config);
  const nameByProvider = new Map((config.providers ?? []).map((p) => [p.id, p.name]));
  return {
    version: PROVIDER_CONFIG_VERSION,
    models: flat.map((m) =>
      toModelProfilePublic(m, m.providerId ? nameByProvider.get(m.providerId) : undefined),
    ),
    providers: (config.providers ?? []).map(toProviderEntryPublic),
    ...(config.defaultModelProfileId
      ? { defaultModelProfileId: config.defaultModelProfileId }
      : {}),
    envFallback: {
      openaiBaseUrlSet: Boolean(env.OPENAI_BASE_URL?.trim()),
      openaiApiKeySet: Boolean(env.OPENAI_API_KEY?.trim()),
    },
  };
}
