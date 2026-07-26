// forked-hive-driver.test.ts — forked-hive-driver-stub story (swappable-driver epic)
// Fast, live-API-free. Confirms the stub throws loudly rather than silently no-oping or
// returning fabricated data (consistent with AD-5's "never guess" discipline), and confirms the
// Driver interface itself required no changes to accommodate it -- the actual claim this story
// makes, not just "does it compile."

import { test } from "node:test";
import assert from "node:assert/strict";
import { ForkedHiveDriver, type Driver } from "./driver.ts";

test("ForkedHiveDriver.runTurn throws a clear NotImplemented error naming itself and pointing at the future doc", async () => {
  const driver: Driver = new ForkedHiveDriver();
  await assert.rejects(
    () => driver.runTurn({ cwd: "/tmp", sessionId: null, prompt: "anything" }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /ForkedHiveDriver/);
      assert.match(e.message, /not.*implement/i);
      assert.match(e.message, /minerva-next-tests-and-driver-paths\.md/);
      return true;
    },
  );
});

test("ForkedHiveDriver satisfies the Driver interface with zero interface changes -- assigning it to a Driver-typed variable is what this test actually proves", () => {
  const driver: Driver = new ForkedHiveDriver();
  assert.equal(typeof driver.runTurn, "function");
});
