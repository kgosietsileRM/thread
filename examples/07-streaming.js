/**
 * 07 – Streaming / Chunked Processing
 *
 * Use runStreaming() to process a large array in chunks via an
 * async generator.  Each chunk is sent to the worker sequentially
 * and results are yielded as they complete.
 *
 * Run:  bun run examples/07-streaming.js
 */

import { createThread } from "../src/index.js";

// ---------- 1. Basic streaming — sum chunks of numbers ----------

const summer = createThread((chunk) => {
  return chunk.reduce((sum, n) => sum + n, 0);
});

const data = Array.from({ length: 100 }, (_, i) => i + 1); // [1..100]

console.log("Processing 100 numbers in chunks of 10...\n");

let chunkIndex = 0;
for await (const partialSum of summer.runStreaming(data, 10, (chunk) => chunk.reduce((a, b) => a + b, 0))) {
  chunkIndex++;
  console.log(`  chunk ${chunkIndex}: partial sum = ${partialSum}`);
}

console.log(`  total chunks: ${chunkIndex}`);
console.log(`  expected total: ${(100 * 101) / 2}`);

await summer.terminate();


// ---------- 2. Streaming with transformation ----------

const transformer = createThread((chunk) => {
  return chunk.map((x) => ({
    input: x,
    squared: x * x,
    root: Math.sqrt(x).toFixed(4),
  }));
});

const values = [1, 4, 9, 16, 25, 36, 49, 64, 81, 100];

console.log("\nTransforming numbers in chunks of 3...\n");

for await (const results of transformer.runStreaming(values, 3, (chunk) => chunk.map((x) => x * x))) {
  for (const r of results) {
    console.log(`  ${r.input} → ${r.squared} (sqrt: ${r.root})`);
  }
}

await transformer.terminate();


// ---------- 3. Streaming with error handling ----------

const risky = createThread((chunk) => {
  return chunk.map((x) => {
    if (x === 7) throw new Error("unlucky number 7");
    return x * 10;
  });
});

const nums = [1, 2, 7, 4, 5];

console.log("\nStreaming with possible errors (chunk of 5)...\n");

try {
  for await (const results of risky.runStreaming(nums, 5, (chunk) => chunk)) {
    console.log("  results:", results);
  }
} catch (err) {
  console.log("  caught:", err.message);
}

await risky.terminate();

console.log("\n✓ All streaming examples passed");
