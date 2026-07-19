/**
 * 04 – Serializer
 *
 * The Serializer utility converts functions to a portable string
 * representation and back.  Useful for storing or transmitting
 * code that includes callbacks.
 *
 * Run:  bun run examples/04-serializer.js
 */

import { Serializer } from "../src/index.js";

// ---------- 1. Serialize / deserialize a function ----------

const add = (a, b) => a + b;
const serialized = Serializer.serialize(add);
console.log("Serialized:", JSON.stringify(serialized));
// { __type: "function", __value: "(a, b) => a + b" }

const restored = Serializer.deserialize(serialized);
console.log("Restored call:", restored(3, 4)); // 7


// ---------- 2. Nested object with functions ----------

const config = {
  name: "my-pipeline",
  transform: (x) => x * 2,
  filter: (x) => x > 10,
  options: {
    timeout: 5000,
    onDone: (result) => console.log("done:", result),
  },
};

const ser = Serializer.serialize(config);
console.log("\nSerialized config name:", ser.name);
console.log("Transform is function:", ser.transform.__type === "function");
console.log("Filter is function:", ser.filter.__type === "function");

const deser = Serializer.deserialize(ser);
console.log("transform(21) =", deser.transform(21)); // 42
console.log("filter(5)  =", deser.filter(5));         // false
console.log("filter(15) =", deser.filter(15));         // true


// ---------- 3. Array of functions ----------

const operations = [
  (x) => x + 1,
  (x) => x * 3,
  (x) => x - 2,
];

const serOps = Serializer.serialize(operations);
const deserOps = Serializer.deserialize(serOps);

let value = 5;
for (const fn of deserOps) {
  value = fn(value);
}
console.log("\nChained 5 → +1 → *3 → -2 =", value); // 16


// ---------- 4. Round-trip through JSON ----------

const payload = {
  users: ["alice", "bob"],
  handler: (msg) => `Hello, ${msg}!`,
};

// Serialize first (converts functions to portable markers), then JSON round-trip
const serPayload = Serializer.serialize(payload);
const json = JSON.stringify(serPayload);
const parsed = JSON.parse(json);
const restored2 = Serializer.deserialize(parsed);

console.log("\nJSON round-trip:");
console.log("  users:", restored2.users);
console.log("  handler('world'):", restored2.handler("world"));

console.log("\n✓ All serializer examples passed");
