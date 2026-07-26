import {
  type ModelProfile,
  ModelProfileSchema,
  OPENAI_COMPATIBLE_PROVIDER_KIND,
  type ProviderApiShape,
  type ProviderConfig,
} from "@okf-wiki/contract";
import { ProviderStoreError } from "./workspace-errors.js";

/** Sole supported product provider kind (not a multi-provider switch). */
export const PROVIDER_KIND = OPENAI_COMPATIBLE_PROVIDER_KIND;

/** Merge provider + model headers (model wins on key conflict, case-sensitive). */
export function mergeHeaders(
  provider?: Record<string, string>,
  model?: Record<string, string>,
): Record<string, string> | undefined {
  const merged = { ...(provider ?? {}), ...(model ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Flatten provider tree → selectable model profiles (runtime view). */
export function flattenModels(config: ProviderConfig): ModelProfile[] {
  const out: ModelProfile[] = [];
  for (const p of config.providers ?? []) {
    for (const m of p.models ?? []) {
      out.push(
        ModelProfileSchema.parse({
          id: m.id,
          name: m.name,
          providerKind: PROVIDER_KIND,
          providerId: p.id,
          modelId: m.modelId,
          baseUrl: p.baseUrl ?? "",
          apiKey: p.apiKey ?? "",
          apiShape: p.apiShape ?? "completions",
          ...(m.maxContextTokens !== undefined ? { maxContextTokens: m.maxContextTokens } : {}),
          headers: mergeHeaders(p.headers, m.headers),
          supportsDeveloperRole: p.supportsDeveloperRole === true,
        }),
      );
    }
  }
  return out;
}

export type ResolvedProviderRuntime = {
  baseUrl: string | undefined;
  apiKey: string;
  apiShape: ProviderApiShape;
  providerKind: typeof OPENAI_COMPATIBLE_PROVIDER_KIND;
  modelId: string | undefined;
  profileId: string | undefined;
  profileName: string | undefined;
  maxContextTokens: number | undefined;
  /** Effective HTTP headers for Pi / probe. */
  headers: Record<string, string> | undefined;
  /**
   * When true, Pi may emit role "developer" for system prompts.
   * Default false for third-party OpenAI-compatible gateways.
   */
  supportsDeveloperRole: boolean;
  source: {
    baseUrl: "stored" | "env" | "none";
    apiKey: "stored" | "env" | "none";
  };
};

/**
 * Resolve credentials for a workspace model selection.
 * Prefers profileId, then matching modelId, then default profile, then env-only.
 */
export function resolveProviderRuntime(
  config: ProviderConfig,
  options: {
    profileId?: string;
    modelId?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedProviderRuntime {
  const env = options.env ?? process.env;
  const envUrl = env.OPENAI_BASE_URL?.trim() ?? "";
  const envKey = env.OPENAI_API_KEY?.trim() ?? "";
  const flat = flattenModels(config);

  let profile: ModelProfile | undefined;
  if (options.profileId) {
    profile = flat.find((m) => m.id === options.profileId);
  }
  if (!profile && options.modelId) {
    profile = flat.find((m) => m.modelId === options.modelId);
  }
  if (!profile && config.defaultModelProfileId) {
    profile = flat.find((m) => m.id === config.defaultModelProfileId);
  }
  if (!profile && flat.length === 1) {
    profile = flat[0];
  }

  const storedUrl = profile?.baseUrl?.trim() ?? "";
  const storedKey = profile?.apiKey?.trim() ?? "";

  let baseUrl: string | undefined;
  let baseUrlSource: ResolvedProviderRuntime["source"]["baseUrl"] = "none";
  if (storedUrl) {
    baseUrl = storedUrl.replace(/\/$/, "");
    baseUrlSource = "stored";
  } else if (envUrl) {
    baseUrl = envUrl.replace(/\/$/, "");
    baseUrlSource = "env";
  }

  let apiKey = "";
  let apiKeySource: ResolvedProviderRuntime["source"]["apiKey"] = "none";
  if (storedKey) {
    apiKey = storedKey;
    apiKeySource = "stored";
  } else if (envKey) {
    apiKey = envKey;
    apiKeySource = "env";
  }

  // Default User-Agent for WAF-sensitive gateways when nothing configured.
  const headers =
    profile?.headers && Object.keys(profile.headers).length > 0
      ? profile.headers
      : { "User-Agent": "node" };

  return {
    baseUrl,
    apiKey: apiKey || "local",
    apiShape: profile?.apiShape ?? "completions",
    providerKind: PROVIDER_KIND,
    modelId: profile?.modelId ?? options.modelId,
    profileId: profile?.id,
    profileName: profile?.name,
    maxContextTokens: profile?.maxContextTokens,
    headers,
    supportsDeveloperRole: profile?.supportsDeveloperRole === true,
    source: { baseUrl: baseUrlSource, apiKey: apiKeySource },
  };
}

/** Look up a profile by id (throws if missing). */
export function getModelProfile(config: ProviderConfig, profileId: string): ModelProfile {
  const profile = flattenModels(config).find((m) => m.id === profileId);
  if (!profile) {
    throw new ProviderStoreError(
      "model_profile_not_found",
      `model profile not found: ${profileId}`,
    );
  }
  return profile;
}

/** True when any model or env can drive a live call. */
export function hasProviderCredentials(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_KEY?.trim()) {
    return true;
  }
  return flattenModels(config).some((m) => Boolean(m.baseUrl?.trim()) || Boolean(m.apiKey?.trim()));
}
