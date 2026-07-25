/** Domain error codes for workspace intake (no HTTP mapping). */
export const WORKSPACE_INTAKE_ERROR_CODES = [
  "workspace_exists",
  "workspace_not_found",
  "invalid_name",
  "invalid_root",
  "model_profile_not_found",
  "source_not_git",
  "source_exists",
  "source_not_found",
  "invalid_ignore",
  "path_escape",
  "io",
] as const;

export type WorkspaceIntakeErrorCode = (typeof WORKSPACE_INTAKE_ERROR_CODES)[number];

/** Domain error codes for provider catalog (no HTTP mapping). */
export const PROVIDER_STORE_ERROR_CODES = [
  "provider_not_found",
  "model_profile_not_found",
  "invalid_config",
  "io",
] as const;

export type ProviderStoreErrorCode = (typeof PROVIDER_STORE_ERROR_CODES)[number];
