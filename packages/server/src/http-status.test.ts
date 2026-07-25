import assert from "node:assert/strict";
import test from "node:test";
import { httpStatusForProviderCode, httpStatusForWorkspaceCode } from "./http-status.ts";

test("httpStatusForWorkspaceCode table", () => {
  const cases: Array<[Parameters<typeof httpStatusForWorkspaceCode>[0], number]> = [
    ["workspace_not_found", 404],
    ["source_not_found", 404],
    ["workspace_exists", 409],
    ["source_exists", 409],
    ["invalid_name", 400],
    ["source_not_git", 400],
    ["io", 500],
  ];
  for (const [code, status] of cases) {
    assert.equal(httpStatusForWorkspaceCode(code), status, code);
  }
});

test("httpStatusForProviderCode table", () => {
  assert.equal(httpStatusForProviderCode("provider_not_found"), 404);
  assert.equal(httpStatusForProviderCode("model_profile_not_found"), 404);
  assert.equal(httpStatusForProviderCode("invalid_config"), 400);
  assert.equal(httpStatusForProviderCode("io"), 500);
});
