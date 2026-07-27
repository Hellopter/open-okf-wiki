import { loadProviderConfig } from "./provider-catalog.js";
import { flattenModels, getModelProfile } from "./provider-runtime.js";

/**
 * Resolve catalog profile → denormalized model ref for workspace create/patch.
 * Free-text modelId is not accepted; selection must come from the provider catalog.
 * When modelProfileId is omitted on create, fall back to default / sole catalog profile.
 */
export async function resolveWorkspaceModelSelection(input: {
  modelProfileId?: string;
}): Promise<{ id: string; profileId?: string }> {
  const catalog = await loadProviderConfig();

  if (input.modelProfileId) {
    const profile = getModelProfile(catalog, input.modelProfileId);
    return { id: profile.modelId, profileId: profile.id };
  }

  // Default profile when available (create with empty form / sole catalog entry).
  if (catalog.defaultModelProfileId) {
    const profile = getModelProfile(catalog, catalog.defaultModelProfileId);
    return { id: profile.modelId, profileId: profile.id };
  }
  const flat = flattenModels(catalog);
  if (flat.length === 1) {
    const profile = flat[0]!;
    return { id: profile.modelId, profileId: profile.id };
  }

  // Empty catalog: denormalized placeholder only (operator must configure Settings later).
  return { id: "openai/default" };
}
