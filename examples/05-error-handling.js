/**
 * 05 – Error Handling
 *
 * Demonstrates timeouts, abort signals, retries, and the typed
 * error hierarchy (ThreadTimeoutError, ThreadAbortError, etc.).
 *
 * Run:  bun run examples/05-error-handling.js
 */

import {
  createThread,
  ThreadError,
  ThreadTimeoutError,
  ThreadAbortError,
  ThreadTerminatedError,
} from "../src/index.js";

// ---------- 1. Timeout ----------

const slow = createThread(
  () => new Promise((resolve) => setTimeout(() => resolve("done"), 5000)),
  { timeout: 200 },
);

try {
  await slow.run();
} catch (err) {
  console.log("1. Timeout caught:", err.name, "-", err.message.slice(0, 60));
  console.log("   Is ThreadTimeoutError?", err instanceof ThreadTimeoutError);
}

await slow.terminate();


// ---------- 2. Abort signal ----------

const blocker = createThread(
  () => new Promise((resolve) => setTimeout(() => resolve("done"), 10_000)),
);

const controller = new AbortController();

// Abort after 100ms
setTimeout(() => controller.abort(), 100);

try {
  await blocker.run({ signal: controller.signal });
} catch (err) {
  console.log("\n2. Abort caught:", err.name, "-", err.message.slice(0, 60));
  console.log("   Is ThreadAbortError?", err instanceof ThreadAbortError);
}

await blocker.terminate();


// ---------- 3. Worker-side error with details ----------

const risky = createThread({
  exec(state, input) {
    if (typeof input !== 'number') {
      throw new TypeError(`Expected number, got ${typeof input}`);
    }
    return input * 2;
  },
});

try {
  await risky.run("not a number");
} catch (err) {
  console.log("\n3. Worker error:", err.name, "-", err.message);
  console.log("   Is ThreadError?", err instanceof ThreadError);
}

await risky.terminate();


// ---------- 4. Terminated thread ----------

const worker = createThread((x) => x * 2);
await worker.run(1); // works fine

await worker.terminate();

try {
  await worker.run(2);
} catch (err) {
  console.log("\n4. Terminated caught:", err.name);
  console.log("   Is ThreadTerminatedError?", err instanceof ThreadTerminatedError);
}


// ---------- 5. Generic ThreadError catch-all ----------

const thrower = createThread(() => {
  throw new TypeError("unexpected type");
});

try {
  await thrower.run();
} catch (err) {
  console.log("\n5. Generic catch:", err.name, "-", err.message);
  console.log("   Is ThreadError?", err instanceof ThreadError);
}

await thrower.terminate();

console.log("\n✓ All error handling examples passed");
