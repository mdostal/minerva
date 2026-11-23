import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
// Imported directly too, so running this file on its own can never reach a live Consus.
import "./setup/no-live-consus.mjs";

// PANT-920: `npm test` loads tests/setup/no-live-consus.mjs, so no test run can
// write into a live Consus decision queue again.

const GUARD = /refusing to reach a live Consus from a test run/;

test("fetch to a live Consus address is refused in-process", async () => {
  for (const url of [
    "http://localhost:8722/api/decisions",
    "http://127.0.0.1:8722/api/questions/import",
    "http://consus:8722/api/decisions",
    "https://hive.tail9a130d.ts.net/api/consus/decisions",
  ]) {
    await assert.rejects(fetch(url), GUARD, url);
  }
});

test("npm test preloads the guard", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /--import \.\/tests\/setup\/no-live-consus\.mjs/);
});

test("fetch to a local fake on an ephemeral port still works", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), "ok");
  } finally {
    server.close();
  }
});

test("spawned node subprocesses inherit the guard", () => {
  const child = spawnSync(
    process.execPath,
    ["-e", "fetch('http://localhost:8722/api/decisions').catch((e) => { console.log(e.message); })"],
    { env: process.env, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, GUARD);
});
