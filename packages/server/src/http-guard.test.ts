import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedCorsOrigin, isTrustedHostHeader } from "./http-util.ts";

const LOCAL_ENV = {} as NodeJS.ProcessEnv;
const LAN_ENV = { OKF_WIKI_ALLOW_LAN: "1" } as NodeJS.ProcessEnv;

test("isTrustedHostHeader accepts loopback hosts only by default", () => {
  assert.equal(isTrustedHostHeader("127.0.0.1:8787", LOCAL_ENV), true);
  assert.equal(isTrustedHostHeader("localhost:8787", LOCAL_ENV), true);
  assert.equal(isTrustedHostHeader("localhost", LOCAL_ENV), true);
  assert.equal(isTrustedHostHeader("[::1]:8787", LOCAL_ENV), true);

  // DNS rebinding: attacker-controlled name resolving to 127.0.0.1.
  assert.equal(isTrustedHostHeader("evil.example:8787", LOCAL_ENV), false);
  assert.equal(isTrustedHostHeader("localhost.evil.example:8787", LOCAL_ENV), false);
  assert.equal(isTrustedHostHeader("192.168.1.10:8787", LOCAL_ENV), false);
  assert.equal(isTrustedHostHeader(undefined, LOCAL_ENV), false);
  assert.equal(isTrustedHostHeader("", LOCAL_ENV), false);
});

test("isTrustedHostHeader accepts private addresses only in LAN mode", () => {
  assert.equal(isTrustedHostHeader("192.168.1.10:8787", LAN_ENV), true);
  assert.equal(isTrustedHostHeader("10.0.0.5:8787", LAN_ENV), true);
  assert.equal(isTrustedHostHeader("172.16.0.2:8787", LAN_ENV), true);
  assert.equal(isTrustedHostHeader("evil.example:8787", LAN_ENV), false);
  assert.equal(isTrustedHostHeader("8.8.8.8:8787", LAN_ENV), false);
});

test("isAllowedCorsOrigin gates non-loopback origins on LAN mode", () => {
  assert.equal(isAllowedCorsOrigin("http://localhost:5173", LOCAL_ENV), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:5173", LOCAL_ENV), true);
  assert.equal(isAllowedCorsOrigin("https://evil.example", LOCAL_ENV), false);
  assert.equal(isAllowedCorsOrigin("http://192.168.1.20:5173", LOCAL_ENV), false);
  assert.equal(isAllowedCorsOrigin("http://192.168.1.20:5173", LAN_ENV), true);
});
