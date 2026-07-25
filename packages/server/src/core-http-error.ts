import type { ServerResponse } from "node:http";
import { ProviderStoreError, WorkspaceIntakeError } from "@okf-wiki/core";
import { httpStatusForProviderCode, httpStatusForWorkspaceCode } from "./http-status.ts";
import { sendError } from "./http-util.ts";

/**
 * If error is a core typed domain error, send mapped HTTP status and return true.
 * Otherwise return false (caller handles generic mapping).
 */
export function trySendCoreDomainError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof WorkspaceIntakeError) {
    sendError(res, httpStatusForWorkspaceCode(error.code), error.message);
    return true;
  }
  if (error instanceof ProviderStoreError) {
    sendError(res, httpStatusForProviderCode(error.code), error.message);
    return true;
  }
  return false;
}
