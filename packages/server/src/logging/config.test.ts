import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadServerLogConfig, resolveLogDir, resolveLogFilePath } from "./config.ts";

test("resolveLogDir prefers OKF_LOG_DIR", () => {
  const dir = resolveLogDir({ OKF_LOG_DIR: "/tmp/okf-custom-logs" });
  assert.equal(dir, path.resolve("/tmp/okf-custom-logs"));
});

test("resolveLogDir uses OKF_WIKI_HOME/logs", () => {
  const dir = resolveLogDir({ OKF_WIKI_HOME: "/tmp/okf-home-x" });
  assert.equal(dir, path.join(path.resolve("/tmp/okf-home-x"), "logs"));
});

test("resolveLogFilePath disables with 0/false/off", () => {
  assert.equal(resolveLogFilePath({ OKF_LOG_FILE: "0" }), null);
  assert.equal(resolveLogFilePath({ OKF_LOG_FILE: "false" }), null);
  assert.equal(resolveLogFilePath({ OKF_LOG_FILE: "OFF" }), null);
});

test("resolveLogFilePath accepts custom absolute path", () => {
  assert.equal(
    resolveLogFilePath({ OKF_LOG_FILE: "/var/log/okf/server.jsonl" }),
    path.resolve("/var/log/okf/server.jsonl"),
  );
});

test("resolveLogFilePath defaults to logDir/server.jsonl", () => {
  assert.equal(
    resolveLogFilePath({ OKF_LOG_DIR: "/tmp/ld" }),
    path.join(path.resolve("/tmp/ld"), "server.jsonl"),
  );
});

test("loadServerLogConfig defaults", () => {
  const cfg = loadServerLogConfig({
    NODE_ENV: "production",
    OKF_LOG_FILE: "0",
    OKF_LOG_PRETTY: "0",
  });
  assert.equal(cfg.level, "info");
  assert.equal(cfg.pretty, false);
  assert.equal(cfg.filePath, null);
  assert.equal(cfg.logHttp, true);
  assert.equal(cfg.logHttpHealth, false);
});

test("loadServerLogConfig respects OKF_LOG_LEVEL and HTTP flags", () => {
  const cfg = loadServerLogConfig({
    NODE_ENV: "development",
    OKF_LOG_LEVEL: "warn",
    OKF_LOG_HTTP: "0",
    OKF_LOG_HTTP_HEALTH: "1",
    OKF_LOG_PRETTY: "0",
    OKF_LOG_FILE: "0",
  });
  assert.equal(cfg.level, "warn");
  assert.equal(cfg.logHttp, false);
  assert.equal(cfg.logHttpHealth, true);
});
