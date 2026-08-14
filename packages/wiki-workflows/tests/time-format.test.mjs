import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("formats absolute timestamps in the system timezone", () => {
  const script = [
    'import { formatLocalDateTime, formatLocalTime } from "./dist/time-format.js";',
    'process.stdout.write(JSON.stringify({',
    '  dateTime: formatLocalDateTime("2026-08-12T00:01:02.000Z"),',
    '  time: formatLocalTime("2026-08-12T00:01:02.000Z"),',
    '}));',
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", TZ: "Asia/Shanghai" },
  });
  assert.deepEqual(JSON.parse(output), {
    dateTime: "Aug 12, 2026, 8:01:02 AM",
    time: "08:01:02",
  });
});

test("preserves invalid timestamp text", async () => {
  const { formatLocalDateTime, formatLocalTime } = await import("../dist/time-format.js");
  assert.equal(formatLocalDateTime("not-a-date"), "not-a-date");
  assert.equal(formatLocalTime("not-a-date"), "not-a-date");
});
