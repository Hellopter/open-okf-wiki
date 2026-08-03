/**
 * Root package surface: error codes only.
 * Business types and helpers must be imported from subpaths
 * (e.g. `@okf-wiki/contract/wiki-runs`, `@okf-wiki/contract/session`).
 */

export {
  PROVIDER_STORE_ERROR_CODES,
  type ProviderStoreErrorCode,
  WORKSPACE_INTAKE_ERROR_CODES,
  type WorkspaceIntakeErrorCode,
} from "./errors.js";
