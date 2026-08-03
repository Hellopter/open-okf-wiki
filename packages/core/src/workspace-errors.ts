import type { ProviderStoreErrorCode, WorkspaceIntakeErrorCode } from "@okf-wiki/contract/workspace";

/**
 * Structured domain error for workspace intake (create / sources / load).
 * Carries `{ code }` only — never HTTP status. Callers map codes at the edge.
 */
export class WorkspaceIntakeError extends Error {
  readonly code: WorkspaceIntakeErrorCode;

  constructor(code: WorkspaceIntakeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkspaceIntakeError";
    this.code = code;
  }
}

/**
 * Structured domain error for provider catalog load/mutate.
 * Carries `{ code }` only — never HTTP status.
 */
export class ProviderStoreError extends Error {
  readonly code: ProviderStoreErrorCode;

  constructor(code: ProviderStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderStoreError";
    this.code = code;
  }
}
