import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage, testProviderConnection } from "@okf-wiki/agent";
import { ModelProfileWriteSchema, ProviderApiShapeSchema, ProviderEntryWriteSchema } from "@okf-wiki/contract/workspace";
import {
  createModelProfile,
  createProviderEntry,
  deleteModelProfile,
  deleteProviderEntry,
  loadProviderConfig,
  resolveProviderRuntime,
  setDefaultModelProfile,
  toProviderPublic,
  updateModelProfile,
  updateProviderEntry,
} from "@okf-wiki/core";
import { trySendCoreDomainError } from "../core-http-error.ts";
import { readJsonBody, sendCaughtError, sendError, sendJson } from "../http-util.ts";
import { getLogger } from "../logging/index.ts";

export async function handleGetProvider(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = await loadProviderConfig();
  sendJson(res, 200, { provider: toProviderPublic(config) });
}

export async function handleCreateProvider(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as unknown;
  const parsed = ProviderEntryWriteSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid provider", parsed.error.flatten());
    return;
  }
  try {
    const { config, provider } = await createProviderEntry(parsed.data);
    const pub = toProviderPublic(config);
    sendJson(res, 201, {
      provider: pub,
      entry: pub.providers.find((p) => p.id === provider.id),
    });
  } catch (error) {
    sendCaughtError(res, 400, error);
  }
}

export async function handleUpdateProvider(
  req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as unknown;
  const parsed = ProviderEntryWriteSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid provider", parsed.error.flatten());
    return;
  }
  try {
    const { config, provider } = await updateProviderEntry(providerId, parsed.data);
    const pub = toProviderPublic(config);
    sendJson(res, 200, {
      provider: pub,
      entry: pub.providers.find((p) => p.id === provider.id),
    });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleDeleteProvider(
  _req: IncomingMessage,
  res: ServerResponse,
  providerId: string,
): Promise<void> {
  try {
    const config = await deleteProviderEntry(providerId);
    sendJson(res, 200, { provider: toProviderPublic(config) });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleCreateModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as unknown;
  const parsed = ModelProfileWriteSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid model profile", parsed.error.flatten());
    return;
  }
  try {
    const { config, profile } = await createModelProfile(parsed.data);
    sendJson(res, 201, {
      provider: toProviderPublic(config),
      model: toProviderPublic(config).models.find((m) => m.id === profile.id),
    });
  } catch (error) {
    sendCaughtError(res, 400, error);
  }
}

export async function handleUpdateModel(
  req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as unknown;
  const parsed = ModelProfileWriteSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid model profile", parsed.error.flatten());
    return;
  }
  try {
    const { config, profile } = await updateModelProfile(profileId, parsed.data);
    sendJson(res, 200, {
      provider: toProviderPublic(config),
      model: toProviderPublic(config).models.find((m) => m.id === profile.id),
    });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleDeleteModel(
  _req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
): Promise<void> {
  try {
    const config = await deleteModelProfile(profileId);
    sendJson(res, 200, { provider: toProviderPublic(config) });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleSetDefaultModel(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as { defaultModelProfileId?: unknown };
  const id =
    body.defaultModelProfileId === null
      ? null
      : typeof body.defaultModelProfileId === "string"
        ? body.defaultModelProfileId.trim()
        : undefined;
  if (id === undefined) {
    sendError(res, 400, "defaultModelProfileId is required (string or null)");
    return;
  }
  try {
    const config = await setDefaultModelProfile(id || null);
    sendJson(res, 200, { provider: toProviderPublic(config) });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

/** Compare base URLs ignoring trailing slashes and case of scheme/host. */
function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase();
  }
}

export async function handleTestProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    modelProfileId?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    apiShape?: unknown;
    modelId?: unknown;
  };

  const stored = await loadProviderConfig();
  const profileId =
    typeof body.modelProfileId === "string" && body.modelProfileId.trim()
      ? body.modelProfileId.trim()
      : undefined;
  const runtime = resolveProviderRuntime(stored, {
    profileId,
    modelId: typeof body.modelId === "string" ? body.modelId : undefined,
  });

  const baseUrl =
    typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl.trim()
      : (runtime.baseUrl ?? "");

  let apiKey: string;
  if (typeof body.apiKey === "string") {
    apiKey = body.apiKey;
  } else {
    apiKey = runtime.source.apiKey !== "none" ? runtime.apiKey : "";
    // Exfiltration guard: the stored credential may only be sent to the base
    // URL it was stored for. Testing a different endpoint requires re-entering
    // the API key explicitly.
    if (apiKey && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(runtime.baseUrl ?? "")) {
      sendError(
        res,
        400,
        "testing a custom base URL with the stored API key is not allowed — re-enter the API key",
      );
      return;
    }
  }

  let apiShape = runtime.apiShape;
  if (body.apiShape !== undefined) {
    const shape = ProviderApiShapeSchema.safeParse(body.apiShape);
    if (!shape.success) {
      sendError(res, 400, "apiShape must be completions or responses");
      return;
    }
    apiShape = shape.data;
  }

  const modelId =
    typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : runtime.modelId;

  if (!baseUrl) {
    sendError(res, 400, "base URL is required to test the connection");
    return;
  }

  const extraHeaders =
    body &&
    typeof body === "object" &&
    "headers" in body &&
    body.headers &&
    typeof body.headers === "object" &&
    !Array.isArray(body.headers)
      ? (body.headers as Record<string, string>)
      : runtime.headers;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  // Never log apiKey. baseUrl host only.
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).host;
  } catch {
    baseHost = "invalid";
  }
  try {
    const result = await testProviderConnection({
      baseUrl,
      apiKey,
      apiShape,
      modelId,
      headers: extraHeaders,
      signal: controller.signal,
    });
    const ok = Boolean(result?.ok);
    getLogger()[ok ? "info" : "warn"](
      {
        event: "provider.test",
        modelId,
        apiShape,
        baseHost,
        ok,
        message: !ok && result && "message" in result ? String(result.message) : undefined,
      },
      ok ? "provider connection test ok" : "provider connection test failed",
    );
    sendJson(res, 200, { result });
  } catch (error) {
    getLogger().warn(
      {
        event: "provider.test",
        modelId,
        apiShape,
        baseHost,
        ok: false,
        err: redactErrorMessage(error),
      },
      "provider connection test threw",
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
