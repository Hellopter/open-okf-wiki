import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveProviderConfig } from "@okf-wiki/core";
import { dispatch } from "../dispatch.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("provider test endpoint never sends the stored key to a custom base URL", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "okf-provider-test-"));
  const previousHome = process.env.OKF_WIKI_HOME;
  process.env.OKF_WIKI_HOME = home;

  // Upstream stub standing in for the stored provider endpoint.
  const seenAuth: string[] = [];
  const upstream = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: [] }));
  });
  const upstreamPort = await listen(upstream);
  const storedBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;

  // A second listener standing in for an attacker-chosen URL.
  const attackerHits: string[] = [];
  const attacker = createServer((req, res) => {
    attackerHits.push(String(req.headers.authorization ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: [] }));
  });
  const attackerPort = await listen(attacker);

  const api = createServer((req, res) => void dispatch(req, res));
  const apiPort = await listen(api);
  const testUrl = `http://127.0.0.1:${apiPort}/api/provider/test`;

  try {
    await saveProviderConfig({
      version: 3,
      defaultModelProfileId: "m1",
      providers: [
        {
          id: "p1",
          name: "Stored",
          kind: "openai-compatible",
          baseUrl: storedBaseUrl,
          apiKey: "sk-stored-secret",
          apiShape: "completions",
          supportsDeveloperRole: false,
          models: [{ id: "m1", name: "M1", modelId: "gpt-test" }],
        },
      ],
    });

    // Stored key + attacker baseUrl → rejected before any request is sent.
    const exfil = await fetch(testUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${attackerPort}/v1` }),
    });
    assert.equal(exfil.status, 400);
    assert.equal(attackerHits.length, 0);

    // Stored key + stored baseUrl → allowed, credential goes to the stored host.
    const legit = await fetch(testUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: storedBaseUrl }),
    });
    assert.equal(legit.status, 200);
    assert.ok(seenAuth.length > 0);
    assert.ok(seenAuth.every((h) => h.includes("sk-stored-secret")));

    // Explicit key + custom baseUrl → allowed, but only the explicit key is sent.
    const explicit = await fetch(testUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${attackerPort}/v1`,
        apiKey: "sk-explicit",
      }),
    });
    assert.equal(explicit.status, 200);
    assert.ok(attackerHits.length > 0);
    assert.ok(attackerHits.every((h) => !h.includes("sk-stored-secret")));

    // Untrusted Host header (DNS rebinding) → rejected by the dispatch guard.
    // fetch() forbids overriding Host, so use a raw http request.
    const reboundStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: apiPort,
          method: "POST",
          path: "/api/provider/test",
          headers: { "content-type": "application/json", host: "evil.example:8787" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(reboundStatus, 403);

    // Untrusted browser Origin → rejected even with a loopback Host.
    const crossSite = await fetch(testUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({}),
    });
    assert.equal(crossSite.status, 403);
  } finally {
    if (previousHome === undefined) delete process.env.OKF_WIKI_HOME;
    else process.env.OKF_WIKI_HOME = previousHome;
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
