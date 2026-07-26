import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  CatalogModelSchema,
  type ModelProfile,
  type ModelProfilePublic,
  type ModelProfileWrite,
  type ProviderConfig,
  ProviderConfigSchema,
  type ProviderEntry,
  type ProviderEntryPublic,
  ProviderEntrySchema,
  type ProviderEntryWrite,
  type ProviderPublic,
} from "@okf-wiki/contract";
import { flattenModels, PROVIDER_KIND } from "./provider-runtime.js";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";
import { ProviderStoreError } from "./workspace-errors.js";

export const PROVIDER_FILE_NAME = "provider.json";

/**
 * User-level provider config path.
 * `$OKF_WIKI_HOME/provider.json` when set, otherwise `~/.okf-wiki/provider.json`.
 */
export function defaultProviderPath(): string {
  const home = process.env.OKF_WIKI_HOME?.trim();
  if (home) {
    return path.join(path.resolve(home), PROVIDER_FILE_NAME);
  }
  return path.join(homedir(), WORKSPACE_DIR_NAME, PROVIDER_FILE_NAME);
}

const emptyProvider = (): ProviderConfig => ({
  version: 3,
  providers: [],
});

function slugifyId(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "item";
}

function uniqueId(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired.slice(0, 56)}-${i}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
  return randomUUID();
}

function normalizeHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (headers === null) return undefined;
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.trim();
    if (!key || typeof v !== "string") continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** All model selection ids across providers. */
function allModelIds(config: ProviderConfig): Set<string> {
  return new Set(flattenModels(config).map((m) => m.id));
}

function allProviderIds(config: ProviderConfig): Set<string> {
  return new Set((config.providers ?? []).map((p) => p.id));
}

/** Parse on-disk catalog (v3 only). Returns null for invalid/legacy files. */
function normalizeLoaded(data: unknown): ProviderConfig | null {
  const parsed = ProviderConfigSchema.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  const config = parsed.data;
  if (
    config.defaultModelProfileId &&
    !flattenModels(config).some((m) => m.id === config.defaultModelProfileId)
  ) {
    delete config.defaultModelProfileId;
  }
  return config;
}

/** Load stored provider config; missing file yields empty catalog. */
export async function loadProviderConfig(
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  try {
    const raw = await readFile(providerPath, "utf8");
    const data = JSON.parse(raw) as unknown;
    const normalized = normalizeLoaded(data);
    if (normalized) {
      return normalized;
    }
    // Legacy / invalid catalog: it may hold API keys, and the next save would
    // overwrite it. Preserve the original as a .bak before starting empty.
    const backupPath = `${providerPath}.bak.${Date.now()}`;
    try {
      await rename(providerPath, backupPath);
      process.stderr.write(
        `provider config at ${providerPath} is not a v3 catalog; ` +
          `moved it to ${backupPath} and starting with an empty catalog\n`,
      );
    } catch {
      // Best-effort: never block loading on backup failure.
    }
    return emptyProvider();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return emptyProvider();
    }
    if (error instanceof SyntaxError) {
      throw new ProviderStoreError(
        "invalid_config",
        `provider config is not valid JSON: ${providerPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Persist provider config atomically (v3 tree only). */
export async function saveProviderConfig(
  config: ProviderConfig,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const parsed = ProviderConfigSchema.parse({
    version: 3,
    providers: config.providers ?? [],
    ...(config.defaultModelProfileId
      ? { defaultModelProfileId: config.defaultModelProfileId }
      : {}),
  });
  if (
    parsed.defaultModelProfileId &&
    !flattenModels(parsed).some((m) => m.id === parsed.defaultModelProfileId)
  ) {
    delete parsed.defaultModelProfileId;
  }
  // Never persist deprecated flat models[]
  const toWrite = {
    version: 3 as const,
    ...(parsed.defaultModelProfileId
      ? { defaultModelProfileId: parsed.defaultModelProfileId }
      : {}),
    providers: parsed.providers,
  };
  const dir = path.dirname(providerPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${providerPath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(toWrite, null, 2)}\n`;
  // mode at open(2) is masked by umask (bits can only be removed), so the
  // secrets file is never readable beyond the owner, even before the chmod.
  await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tempPath, 0o600);
  } catch {
    // Windows or restricted FS — ignore.
  }
  await rename(tempPath, providerPath);
  try {
    await chmod(providerPath, 0o600);
  } catch {
    // ignore
  }
  return ProviderConfigSchema.parse(toWrite);
}

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
    version: 3,
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

function findProviderIndex(config: ProviderConfig, providerId: string): number {
  return (config.providers ?? []).findIndex((p) => p.id === providerId);
}

function findModelLocation(
  config: ProviderConfig,
  profileId: string,
): { providerIndex: number; modelIndex: number } | null {
  for (let pi = 0; pi < (config.providers ?? []).length; pi++) {
    const p = config.providers![pi]!;
    const mi = p.models.findIndex((m) => m.id === profileId);
    if (mi >= 0) return { providerIndex: pi, modelIndex: mi };
  }
  return null;
}

/** Create a provider endpoint (optionally with zero models). */
export async function createProviderEntry(
  input: ProviderEntryWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; provider: ProviderEntry }> {
  const current = await loadProviderConfig(providerPath);
  const preferred = input.id?.trim() || slugifyId(input.name);
  const id = uniqueId(preferred, allProviderIds(current));
  const headers = normalizeHeaders(input.headers === null ? null : input.headers);
  const provider = ProviderEntrySchema.parse({
    id,
    name: input.name.trim(),
    kind: PROVIDER_KIND,
    baseUrl: (input.baseUrl ?? "").trim(),
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    apiShape: input.apiShape ?? "completions",
    supportsDeveloperRole: input.supportsDeveloperRole === true,
    ...(headers ? { headers } : {}),
    models: [],
  });
  const config = await saveProviderConfig(
    {
      version: 3,
      providers: [...(current.providers ?? []), provider],
      ...(current.defaultModelProfileId
        ? { defaultModelProfileId: current.defaultModelProfileId }
        : {}),
    },
    providerPath,
  );
  return {
    config,
    provider: config.providers.find((p) => p.id === id)!,
  };
}

/** Update provider connection fields (not models list). */
export async function updateProviderEntry(
  providerId: string,
  input: ProviderEntryWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; provider: ProviderEntry }> {
  const current = await loadProviderConfig(providerPath);
  const index = findProviderIndex(current, providerId);
  if (index < 0) {
    throw new ProviderStoreError("provider_not_found", `provider not found: ${providerId}`);
  }
  const existing = current.providers[index]!;
  let apiKey = existing.apiKey;
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      apiKey = "";
    } else {
      apiKey = input.apiKey;
    }
  }
  let headers = existing.headers;
  if (input.headers !== undefined) {
    headers = normalizeHeaders(input.headers === null ? null : input.headers);
  }
  const supportsDeveloperRole =
    input.supportsDeveloperRole !== undefined
      ? input.supportsDeveloperRole === true
      : existing.supportsDeveloperRole === true;
  const provider = ProviderEntrySchema.parse({
    id: existing.id,
    name: input.name.trim(),
    kind: PROVIDER_KIND,
    baseUrl: (input.baseUrl ?? "").trim(),
    apiKey,
    apiShape: input.apiShape ?? existing.apiShape,
    supportsDeveloperRole,
    ...(headers ? { headers } : {}),
    models: existing.models,
  });
  const providers = [...current.providers];
  providers[index] = provider;
  const config = await saveProviderConfig(
    {
      version: 3,
      providers,
      ...(current.defaultModelProfileId
        ? { defaultModelProfileId: current.defaultModelProfileId }
        : {}),
    },
    providerPath,
  );
  return { config, provider };
}

/** Delete a provider and all of its models. */
export async function deleteProviderEntry(
  providerId: string,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  const providers = (current.providers ?? []).filter((p) => p.id !== providerId);
  if (providers.length === current.providers.length) {
    throw new ProviderStoreError("provider_not_found", `provider not found: ${providerId}`);
  }
  const remainingIds = new Set(providers.flatMap((p) => p.models.map((m) => m.id)));
  let defaultModelProfileId = current.defaultModelProfileId;
  if (defaultModelProfileId && !remainingIds.has(defaultModelProfileId)) {
    defaultModelProfileId = [...remainingIds][0];
  }
  return saveProviderConfig(
    {
      version: 3,
      providers,
      ...(defaultModelProfileId ? { defaultModelProfileId } : {}),
    },
    providerPath,
  );
}

/**
 * Create a model profile in the catalog.
 * - With providerId: add under that provider (connection fields ignored unless provider empty).
 * - Without: create a new provider (or merge into same baseUrl+key+shape).
 */
export async function createModelProfile(
  input: ModelProfileWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; profile: ModelProfile }> {
  const write = {
    name: input.name.trim(),
    modelId: input.modelId.trim(),
    baseUrl: (input.baseUrl ?? "").trim(),
    apiShape: input.apiShape ?? "completions",
    providerKind: PROVIDER_KIND,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    providerId: input.providerId?.trim(),
    providerName: input.providerName?.trim(),
    headers: normalizeHeaders(input.headers === null ? null : (input.headers ?? undefined)),
    supportsDeveloperRole: input.supportsDeveloperRole,
  };
  if (!write.name || !write.modelId) {
    throw new ProviderStoreError("invalid_config", "name and modelId are required");
  }

  const current = await loadProviderConfig(providerPath);
  const profileId = uniqueId(
    input.id?.trim() || slugifyId(write.name) || slugifyId(write.modelId),
    allModelIds(current),
  );

  const catalogModel = CatalogModelSchema.parse({
    id: profileId,
    name: write.name,
    modelId: write.modelId,
    ...(typeof input.maxContextTokens === "number"
      ? { maxContextTokens: input.maxContextTokens }
      : {}),
  });

  const providers = [...(current.providers ?? [])];
  let targetIndex: number;

  if (write.providerId) {
    targetIndex = findProviderIndex(current, write.providerId);
    if (targetIndex < 0) {
      throw new ProviderStoreError("provider_not_found", `provider not found: ${write.providerId}`);
    }
  } else {
    // Merge into existing endpoint if baseUrl+shape+key match.
    targetIndex = providers.findIndex(
      (p) =>
        (p.baseUrl ?? "").trim() === write.baseUrl &&
        (p.apiShape ?? "completions") === write.apiShape &&
        (p.apiKey ?? "") === write.apiKey,
    );
  }

  if (targetIndex >= 0) {
    const p = providers[targetIndex]!;
    const nextHeaders = write.headers !== undefined ? write.headers : p.headers;
    const supportsDeveloperRole =
      write.supportsDeveloperRole !== undefined
        ? write.supportsDeveloperRole === true
        : p.supportsDeveloperRole === true;
    providers[targetIndex] = ProviderEntrySchema.parse({
      ...p,
      // Allow first create under empty provider to set connection from form.
      baseUrl: p.baseUrl?.trim() || write.baseUrl,
      apiKey: p.apiKey || write.apiKey,
      apiShape: p.apiShape ?? write.apiShape,
      supportsDeveloperRole,
      ...(nextHeaders ? { headers: nextHeaders } : { headers: undefined }),
      models: [...p.models, catalogModel],
    });
  } else {
    const providerId = uniqueId(
      slugifyId(write.providerName || write.name || write.baseUrl || "provider"),
      allProviderIds(current),
    );
    providers.push(
      ProviderEntrySchema.parse({
        id: providerId,
        name: (write.providerName || write.name || "Provider").slice(0, 120),
        kind: PROVIDER_KIND,
        baseUrl: write.baseUrl,
        apiKey: write.apiKey,
        apiShape: write.apiShape,
        supportsDeveloperRole: write.supportsDeveloperRole === true,
        ...(write.headers ? { headers: write.headers } : {}),
        models: [catalogModel],
      }),
    );
  }

  const config = await saveProviderConfig(
    {
      version: 3,
      providers,
      defaultModelProfileId:
        current.defaultModelProfileId ??
        (flattenModels({ version: 3, providers }).length === 1 ? profileId : undefined),
    },
    providerPath,
  );
  const profile = flattenModels(config).find((m) => m.id === profileId)!;
  return { config, profile };
}

/** Update an existing model profile; connection edits update the parent provider. */
export async function updateModelProfile(
  profileId: string,
  input: ModelProfileWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; profile: ModelProfile }> {
  const current = await loadProviderConfig(providerPath);
  const loc = findModelLocation(current, profileId);
  if (!loc) {
    throw new ProviderStoreError(
      "model_profile_not_found",
      `model profile not found: ${profileId}`,
    );
  }
  const provider = current.providers[loc.providerIndex]!;
  const existingModel = provider.models[loc.modelIndex]!;

  let maxContextTokens = existingModel.maxContextTokens;
  if (input.maxContextTokens !== undefined) {
    maxContextTokens = input.maxContextTokens === null ? undefined : input.maxContextTokens;
  }

  const catalogModel = CatalogModelSchema.parse({
    id: existingModel.id,
    name: input.name.trim(),
    modelId: input.modelId.trim(),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(existingModel.headers ? { headers: existingModel.headers } : {}),
  });

  let apiKey = provider.apiKey;
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      apiKey = "";
    } else {
      apiKey = input.apiKey;
    }
  }

  let headers = provider.headers;
  if (input.headers !== undefined) {
    headers = normalizeHeaders(input.headers === null ? null : input.headers);
  }
  const supportsDeveloperRole =
    input.supportsDeveloperRole !== undefined
      ? input.supportsDeveloperRole === true
      : provider.supportsDeveloperRole === true;

  const models = [...provider.models];
  models[loc.modelIndex] = catalogModel;

  const nextProvider = ProviderEntrySchema.parse({
    id: provider.id,
    name: input.providerName?.trim() || provider.name,
    kind: PROVIDER_KIND,
    baseUrl: (input.baseUrl ?? provider.baseUrl ?? "").trim(),
    apiKey,
    apiShape: input.apiShape ?? provider.apiShape,
    supportsDeveloperRole,
    ...(headers ? { headers } : {}),
    models,
  });

  const providers = [...current.providers];
  providers[loc.providerIndex] = nextProvider;

  const config = await saveProviderConfig(
    {
      version: 3,
      providers,
      ...(current.defaultModelProfileId
        ? { defaultModelProfileId: current.defaultModelProfileId }
        : {}),
    },
    providerPath,
  );
  const profile = flattenModels(config).find((m) => m.id === profileId)!;
  return { config, profile };
}

/** Remove a model profile; drops empty parent provider. */
export async function deleteModelProfile(
  profileId: string,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  const loc = findModelLocation(current, profileId);
  if (!loc) {
    throw new ProviderStoreError(
      "model_profile_not_found",
      `model profile not found: ${profileId}`,
    );
  }
  const provider = current.providers[loc.providerIndex]!;
  const models = provider.models.filter((m) => m.id !== profileId);
  let providers = [...current.providers];
  if (models.length === 0) {
    providers = providers.filter((_, i) => i !== loc.providerIndex);
  } else {
    providers[loc.providerIndex] = ProviderEntrySchema.parse({
      ...provider,
      models,
    });
  }
  const remaining = flattenModels({ version: 3, providers });
  let defaultModelProfileId = current.defaultModelProfileId;
  if (defaultModelProfileId === profileId) {
    defaultModelProfileId = remaining[0]?.id;
  }
  return saveProviderConfig(
    {
      version: 3,
      providers,
      ...(defaultModelProfileId ? { defaultModelProfileId } : {}),
    },
    providerPath,
  );
}

/** Set which profile is the default for new workspaces. */
export async function setDefaultModelProfile(
  profileId: string | null,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  if (profileId) {
    if (!flattenModels(current).some((m) => m.id === profileId)) {
      throw new ProviderStoreError(
        "model_profile_not_found",
        `model profile not found: ${profileId}`,
      );
    }
    return saveProviderConfig(
      {
        version: 3,
        providers: current.providers,
        defaultModelProfileId: profileId,
      },
      providerPath,
    );
  }
  return saveProviderConfig(
    {
      version: 3,
      providers: current.providers,
    },
    providerPath,
  );
}
