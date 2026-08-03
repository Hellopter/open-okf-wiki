import type { ProviderStoreErrorCode, WorkspaceIntakeErrorCode } from "@okf-wiki/contract/workspace";

/** Map workspace intake domain codes → HTTP status (server only). */
export function httpStatusForWorkspaceCode(code: WorkspaceIntakeErrorCode): number {
  switch (code) {
    case "workspace_not_found":
    case "source_not_found":
      return 404;
    case "workspace_exists":
    case "source_exists":
      return 409;
    case "io":
      return 500;
    default:
      return 400;
  }
}

/** Map provider store domain codes → HTTP status (server only). */
export function httpStatusForProviderCode(code: ProviderStoreErrorCode): number {
  switch (code) {
    case "provider_not_found":
    case "model_profile_not_found":
      return 404;
    case "io":
      return 500;
    default:
      return 400;
  }
}
