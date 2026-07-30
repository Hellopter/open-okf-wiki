import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { dispatch } from "./dispatch.ts";

test("workspace routes reject the removed rootPath query", async () => {
  const server = createServer((req, res) => void dispatch(req, res));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/workspaces/any?rootPath=%2Ftmp%2Flegacy`,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "rootPath query is not supported" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
