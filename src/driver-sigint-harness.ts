// driver-sigint-harness.ts — test fixture only, spawned as a child process by driver.test.ts.
// Proves SIGINT/SIGTERM actually kill an in-flight `claude` child driven via SpawnDriver.
// Can't test this from inside the test process itself: sending SIGINT there would kill the
// test runner along with it. This harness is the thing that receives the signal instead.

import { SpawnDriver } from "./driver.ts";

const driver = new SpawnDriver();
const prompt = process.argv[2] ?? "Say exactly the word pong and nothing else.";

driver
  .runTurn({ cwd: process.cwd(), sessionId: null, prompt })
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch((e) => {
    process.stderr.write(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
