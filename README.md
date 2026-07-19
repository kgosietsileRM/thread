# thread

**Enterprise Web Worker & GPU Compute Framework**

A modular, feature-rich library for running CPU-intensive work in **Web Workers** and **WebGPU compute shaders**. Includes a thread pool with work-stealing, dependency tracking, health checks, 57+ built-in GPU operations, and framework adapters for Preact, React, Svelte, Vue, Solid, Zustand, Redux, and Preact Signals.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Environment Compatibility](#environment-compatibility)
  - [Supported Runtimes](#supported-runtimes)
  - [Environment-Specific Entry Points](#environment-specific-entry-points)
  - [Environment Detection](#environment-detection)
  - [Config in Different Environments](#config-in-different-environments)
  - [GPU in Different Environments](#gpu-in-different-environments)
- [Configuration](#configuration)
  - [Config File Format](#config-file-format)
  - [Supported Frameworks](#supported-frameworks)
  - [Supported State Managers](#supported-state-managers)
  - [Custom Framework / State Manager](#custom-framework--state-manager)
- [Architecture](#architecture)
- [CPU Workers](#cpu-workers)
  - [Single Thread](#single-thread)
  - [Thread Pool](#thread-pool)
  - [Stateful Workers](#stateful-workers)
  - [Streaming](#streaming)
  - [Function Chaining](#function-chaining)
- [GPU Compute](#gpu-compute)
  - [One-Liner Ops](#one-liner-ops)
  - [Multi-Op Pipelines](#multi-op-pipelines)
  - [Built-in Operations](#built-in-operations)
  - [Pipeline Chaining](#pipeline-chaining)
  - [Fluent Data Pipelines](#fluent-data-pipelines)
  - [Map (Parallel Transform)](#map-parallel-transform)
  - [Reductions](#reductions)
  - [Profiling & Auto-Tuning](#profiling--auto-tuning)
- [Framework Integration](#framework-integration)
  - [Hooks](#hooks)
  - [Adapters](#adapters)
- [Error Handling](#error-handling)
- [TypeScript](#typescript)
- [Real-Life Use Cases](#real-life-use-cases)
- [API Reference](#api-reference)

---

## Installation

```bash
npm install thread
# or
bun add thread
```

Peer dependency (optional — only needed for hooks):
```bash
npm install preact   # or react
```

---

## Quick Start

### CPU Workers

```js
import { createThread, createPool } from 'thread';

// Single thread — run a function in a Web Worker
const t = createThread((x) => x * 2);
console.log(await t.run(5)); // 10

// Thread pool — distribute work across 4 workers
const pool = createPool(4, (x) => x + 1);
const { id, promise } = pool.run(1);
console.log(await promise); // 2
```

### GPU Compute

```js
import { createGPUOp } from 'thread';

// Define a GPU operation from a plain JS function
const gpu = createGPUOp('double', (data) => data.value * 2);

const result = await gpu.run('double', {
  inputs: { data: new Float32Array([1, 2, 3]) },
  outputs: { result: 3 },
});
console.log(result.result); // Float32Array [2, 4, 6]
```

---

## Environment Compatibility

thread works across **5+ JavaScript runtimes** out of the box. The library auto-detects your environment and uses the appropriate APIs for Workers, GPU, and config loading.

### Supported Runtimes

| Runtime | Worker API | GPU API | Config Loading | Import Path |
|---------|-----------|---------|---------------|-------------|
| **Browser** | Web Workers (Blob URLs) | `navigator.gpu` | Filesystem (Node) or programmatic | `thread` |
| **Node.js** | `worker_threads` (eval) | `@aspect-build/webgpu-node` | `fs.readFileSync` | `thread/node` |
| **Bun** | `worker_threads` (eval) | Bun built-in (experimental) | `fs.readFileSync` | `thread/node` |
| **Deno** | Deno Workers (Blob URLs) | `Deno.gpu` | `Deno.readTextFileSync` | `thread/deno` |
| **Edge** | Web Workers (Blob URLs) | `navigator.gpu` | Programmatic only | `thread/edge` |
| **Cloudflare Workers** | No Worker support | `navigator.gpu` | Programmatic only | `thread/edge` |

### Environment-Specific Entry Points

Use the appropriate import for your runtime:

```js
// Browser (auto-detected)
import { Thread, ThreadPool } from 'thread';

// Node.js / Bun
import { Thread, ThreadPool } from 'thread/node';

// Deno
import { Thread, ThreadPool } from 'thread/deno';

// Edge (Cloudflare Workers, Vercel Edge, Netlify Edge)
import { Thread, ThreadPool } from 'thread/edge';
```

The main `thread` export uses **conditional exports** — your bundler/runtime automatically picks the right entry point based on the `browser`, `node`, `bun`, `deno`, and `edge` conditions.

### Environment Detection

Use the `env` object to detect your runtime and available features:

```js
import { env } from 'thread/env';

console.log(env.runtime);      // 'browser' | 'node' | 'bun' | 'deno' | 'edge'
console.log(env.isNode);       // true
console.log(env.hasWorker);    // true
console.log(env.hasGPU);       // false (unless WebGPU is enabled)
console.log(env.hasFS);        // true (Node/Bun only)
console.log(env.isMainThread); // true

// Platform-specific helpers
const cwd = env.getCwd();                    // '/home/user/project'
const fs = env.requireModule('node:fs');     // fs module or null
const exists = env.fileExists('./config.js'); // true/false
const path = env.resolvePath('src', 'index.js'); // '/home/user/project/src/index.js'
```

### Config in Different Environments

**Browser/Edge:** Config must be set programmatically (no filesystem access):

```js
import { setProgrammaticConfig } from 'thread/config';

setProgrammaticConfig({
  framework: 'react',
  stateManager: 'zustand',
  gpu: { workgroupSize: 512 },
});
```

**Node.js/Bun/Deno:** Use the standard `thread.config.js` file in your project root:

```js
// thread.config.js
import { defineConfig } from 'thread/config';

export default defineConfig({
  framework: 'preact',
  stateManager: 'zustand',
});
```

### GPU in Different Environments

WebGPU availability varies by runtime:

```js
import { isGPUAvailable, gpuEnv } from 'thread/gpu/env';

// Async check (recommended)
if (await isGPUAvailable()) {
  const gpu = new GPUCompute({ shader: myShader });
  await gpu.init();
} else {
  // Fall back to CPU
  const cpu = createGPUWithFallback(shader, cpuFn);
}

// Sync check (fast, less reliable)
if (gpuEnv.sync) {
  console.log('WebGPU detected');
}

// Detailed diagnostics
const info = await gpuEnv.info();
console.log(info);
// { available: true, runtime: 'browser', adapterName: 'NVIDIA RTX 4090', ... }
```

**Node.js GPU:** Install a WebGPU binding:
```bash
npm install @aspect-build/webgpu-node
# or
npm install node-webgpu
```

---

## Configuration

thread uses a config file (`thread.config.js`) in your project root to
configure the library globally.  **All fields are optional** — thread
works out of the box with sensible defaults (Preact + Zustand).

### Config File Format

```js
// thread.config.js
import { defineConfig } from 'thread/config';

export default defineConfig({
  // UI framework — hooks are auto-resolved at load time
  framework: 'react',        // 'preact' | 'react' | 'svelte' | 'vue' | 'solid' | 'angular' | 'custom'

  // State manager — determines which adapter shortcuts are available
  stateManager: 'zustand',   // 'zustand' | 'signals' | 'redux' | 'jotai' | 'mobx' | 'vanilla' | 'custom'

  // GPU compute defaults (applied to all GPUCompute instances)
  gpu: {
    workgroupSize: 256,             // Must match @workgroup_size(N) in shaders
    maxBufferSize: 256 * 1024 * 1024, // 256 MB max buffer
    powerPreference: 'high-performance', // 'low-power' | 'high-performance'
    // cpuFallback: (input) => { ... },  // Called when WebGPU unavailable
  },

  // Thread defaults (applied to all threads via factories)
  thread: {
    timeout: 30_000,                // 30 second task timeout
    // idleTimeout: 60_000,         // Auto-terminate idle threads
    // healthCheckInterval: 10_000, // Ping threads every 10s
  },

  // Pool defaults (applied to all pools via factories)
  pool: {
    autoRestart: true,              // Replace crashed workers
    enableStealing: true,           // Work-stealing between threads
    // maxSize: 16,                 // Cap thread count
  },

  // Development options
  dev: {
    log: false,                     // Forward worker logs to main thread
    metrics: false,                 // Enable metrics collection
    warnOnLongTask: 0,              // Warn if task > N ms (0 = disabled)
  },
});
```

### Supported Frameworks

| Framework | Import path | Hook support | Notes |
|-----------|------------|-------------|-------|
| Preact | `preact/hooks` | Full | Default. Identical API to React. |
| React | `react` | Full | Works with React 18+. |
| Svelte | `svelte/reactivity` | Partial | Svelte 5 runes. Some hooks are shims. |
| Vue | `vue` | Partial | Composition API. `ref()` → `useState`. |
| Solid | `solid-js` | Full | Exports hooks directly. |
| Angular | — | — | Coming soon. Use `custom` with a shim. |
| Custom | — | — | User provides `customHookSource`. |

### Supported State Managers

| State Manager | Adapter type | Thread adapter | GPU adapter | Notes |
|--------------|-------------|---------------|-------------|-------|
| Zustand | action | `createZustandBinder` | `createGPUBinder` | Default. Action-based. |
| Signals | signal | `createSignalBinder` | `createGPUSignalBinder` | Preact Signals. `.value` based. |
| Redux | setter | `createStoreBinder` | `createGPUStoreBinder` | Generic setter callback. |
| Jotai | setter | `createStoreBinder` | `createGPUStoreBinder` | Uses Redux adapter. |
| MobX | setter | `createStoreBinder` | `createGPUStoreBinder` | Uses Redux adapter. |
| Vanilla | setter | `createStoreBinder` | `createGPUStoreBinder` | Any setter function. |
| Custom | — | — | — | User provides `customAdapter`. |

### Custom Framework / State Manager

```js
// thread.config.js
import { defineConfig } from 'thread/config';

export default defineConfig({
  framework: 'custom',
  customHookSource: async () => {
    // Import your framework's hooks
    const mod = await import('my-framework/hooks');
    return {
      useState: mod.useState,
      useEffect: mod.useEffect,
      useRef: mod.useRef,
      useCallback: mod.useCallback,
      useMemo: mod.useMemo,
    };
  },

  stateManager: 'custom',
  customAdapter: (instance, store, action) => ({
    run: async (...args) => {
      const result = await instance.run(...args);
      store.dispatch({ type: action, payload: result });
    },
    destroy: () => {},
  }),
});
```

---

## Architecture

```
thread/
├── package.json
├── README.md
├── thread.config.js.example    Example config file
├── src/
│   ├── index.js              Main barrel export (re-exports everything)
│   ├── config.js             Config entry (thread/config)
│   ├── types.js              TypeScript type definitions
│   ├── thread.js             Thread class — single worker lifecycle
│   ├── pool.js               ThreadPool — priority queue, deps, work-stealing
│   ├── metrix.js             Metrics — performance counters
│   ├── serializer.js         Serializer — JSON-safe with function support
│   ├── error.js              Error hierarchy (ThreadError, GPUComputeError, …)
│   ├── factory.js            Factory functions (createThread, createPool, …)
│   ├── hooks.js              Framework-agnostic hooks (useThread, usePool, …)
│   ├── adapters.js           Framework adapters (Zustand, Signals, …)
│   ├── config/
│   │   ├── index.js          Config loader (getConfig, setConfig)
│   │   ├── define.js         defineConfig() helper
│   │   ├── schema.js         Defaults, validation, mergeWithDefaults
│   │   ├── frameworks.js     Framework → hooks resolver
│   │   └── adapters.js       State manager → adapter registry
│   └── gpu/
│       ├── index.js          GPU barrel export
│       ├── gpu.js            GPUCompute class — WebGPU executor
│       ├── shaders.js        Built-in ops, shader DSL (57+ ops)
│       ├── helpers.js        Auto-boxing, transpile, jsToWgsl
│       ├── chains.js         PipelineChain + DataPipelineChain
│       ├── special.js        Multi-pass: matmul, reduce, histogram, scan
│       ├── hooks.js          GPU-specific hooks (useGPU, useGPURun, …)
│       └── adapters.js       GPU-specific adapters (Zustand, Signals, …)
└── tests/
    └── thread.spec.js        Full test suite (238 tests, 759 expects)
```

---

## CPU Workers

### Single Thread

Run a function in a dedicated Web Worker.  The thread is created lazily
on the first `run()` call and can be terminated when no longer needed.

```js
import { createThread } from 'thread';

// Simple function — auto-serialized and sent to a worker
const t = createThread((a, b) => a + b);
console.log(await t.run(3, 4)); // 7

// With options
const t2 = createThread((data) => process(data), {
  timeout: 10_000,          // reject if task takes >10s
  idleTimeout: 60_000,      // auto-terminate after 60s idle
  concurrency: 2,           // allow 2 concurrent tasks
  onLog: (msg) => console.log('[worker]', msg),
  onTiming: (ms) => console.log(`Done in ${ms.toFixed(1)}ms`),
});

// Cleanup
await t.terminate();
```

### Thread Pool

Distribute work across multiple workers with a priority queue,
dependency tracking, and work-stealing.

```js
import { createPool } from 'thread';

const pool = createPool(4, (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sqrt(i);
  return sum;
});

// Run 20 tasks across 4 workers
const results = await Promise.all(
  Array.from({ length: 20 }, (_, i) => pool.run(1_000_000 + i).promise)
);

// Priority queue — lower number = higher priority
pool.run(urgentData, { priority: 0 });
pool.run(batchData,  { priority: 10 });

// Dependencies — chain tasks
const step1 = pool.run('raw-data');
const step2 = pool.run(step1.id, { dependsOn: [step1.id] });
await step2.promise;

// Dynamic resizing
pool.scaleTo(8);   // burst mode
await pool.drain();
pool.scaleTo(2);   // back to normal
```

### Stateful Workers

Workers with persistent state across tasks (setup → exec → cleanup):

```js
import { createThread } from 'thread';

const db = createThread({
  setup() {
    return { conn: openDatabase(), cache: new Map() };
  },
  async exec(state, query, ctx) {
    ctx.log(`Running: ${query}`);
    ctx.reportProgress(0);
    if (state.cache.has(query)) return state.cache.get(query);
    const result = await state.conn.query(query);
    state.cache.set(query, result);
    ctx.reportProgress(1);
    return result;
  },
  async cleanup(state) {
    await state.conn.close();
  },
}, { timeout: 10_000 });

const rows = await db.run('SELECT * FROM users');
await db.terminateGracefully(); // cleanup runs automatically
```

### Streaming

Process large arrays in chunks, yielding results as they complete:

```js
const t = createThread((chunk) => chunk.map((x) => x * x));
const data = Array.from({ length: 10_000 }, (_, i) => i);

// Process in chunks of 1000
for (let i = 0; i < data.length; i += 1000) {
  const chunk = data.slice(i, i + 1000);
  const result = await t.run(chunk);
  console.log(`Chunk ${i / 1000 + 1} done:`, result);
}
```

### Function Chaining

Chain multiple operations on the same thread:

```js
const t = createThread((x) => x * 2);

const chain = t.runChain(5);       // start with 5
chain.run((x) => x + 1);          // → 11
chain.run((x) => x * 3);          // → 33
const final = await chain.run((x) => x - 1); // → 32
```

---

## GPU Compute

### One-Liner Ops

Define GPU operations from plain JavaScript functions.  The function is
automatically transpiled to WGSL and executed on the GPU:

```js
import { createGPUOp } from 'thread';

const gpu = createGPUOp('double', (data) => data.value * 2);

const result = await gpu.run('double', {
  inputs: { data: new Float32Array([1, 2, 3, 4]) },
  outputs: { result: 4 },
});
console.log(result.result); // Float32Array [2, 4, 6, 8]
```

### Multi-Op Pipelines

Register multiple operations and switch between them:

```js
import { createGPUPipeline } from 'thread';

const gpu = createGPUPipeline([
  ['double', (data) => data.value * 2],
  ['negate', (data) => -data.value],
  ['sqrt',   (data) => Math.sqrt(data.value)],
]);

// Run any registered op
await gpu.run('double', { inputs: { data }, outputs: { result: 4 } });
await gpu.run('sqrt',   { inputs: { data }, outputs: { result: 4 } });
```

### Built-in Operations

57+ built-in operations — zero shader code required:

```js
import { GPUCompute } from 'thread';

const gpu = new GPUCompute();

// Arithmetic
await gpu.run('multiply', { inputs: { a, b }, outputs: { result: N } });
await gpu.run('add',      { inputs: { a, b }, outputs: { result: N } });
await gpu.run('subtract', { inputs: { a, b }, outputs: { result: N } });
await gpu.run('divide',   { inputs: { a, b }, outputs: { result: N } });
await gpu.run('power',    { inputs: { a, b }, outputs: { result: N } });

// Math
await gpu.run('sqrt',  { inputs: { data }, outputs: { result: N } });
await gpu.run('abs',   { inputs: { data }, outputs: { result: N } });
await gpu.run('sin',   { inputs: { data }, outputs: { result: N } });
await gpu.run('exp',   { inputs: { data }, outputs: { result: N } });
await gpu.run('log',   { inputs: { data }, outputs: { result: N } });

// Comparison
await gpu.run('clamp', { inputs: { data }, uniforms: { min, max }, outputs: { result: N } });
await gpu.run('lerp',  { inputs: { a, b }, uniforms: { t }, outputs: { result: N } });

// Aggregation
await gpu.run('reduce_sum', { inputs: { data }, outputs: { result: N } });
await gpu.run('reduce_max', { inputs: { data }, outputs: { result: N } });
await gpu.run('reduce_min', { inputs: { data }, outputs: { result: N } });

// Matrix
await gpu.run('matmul', { inputs: { A, B }, uniforms: { M, N, K }, outputs: { C } });
```

### Pipeline Chaining

Chain multiple GPU operations without copying data back to the CPU:

```js
const gpu = new GPUCompute();
gpu.define('scale', (data, { factor }) => data.value * factor);
gpu.define('offset', (data, { bias }) => data.value + bias);

const chain = gpu.pipe('scale', 4)
  .run({ data: new Float32Array([1, 2, 3, 4]) }, { factor: new Float32Array([2]) })
  .pipe('offset', 4)
  .run({}, { bias: new Float32Array([10]) });

const result = await chain.result();
// [12, 14, 16, 18]
```

### Fluent Data Pipelines

Use named methods for a fluent API:

```js
const gpu = new GPUCompute();
gpu.define('normalize', (data, { mean, std }) => (data.value - mean) / std);
gpu.define('clamp', (data, { min, max }) => Math.min(Math.max(data.value, min), max));

const pipeline = gpu.pipe('normalize', 1000)
  .normalize({ mean: new Float32Array([50]), std: new Float32Array([15]) })
  .clamp({ min: new Float32Array([0]), max: new Float32Array([100]) })
  .result();

const normalized = await pipeline;
```

### Map (Parallel Transform)

Apply a function to every element in parallel:

```js
const gpu = new GPUCompute();
const data = new Float32Array(1_000_000);

// Parallel map — runs on GPU
const result = await gpu.map(data, (x) => x * x + 1);
```

### Reductions

Sum, min, max across large datasets:

```js
import { createGPUReducer } from 'thread';

const gpu = createGPUReducer();
const data = new Float32Array(1_000_000);

const sum = await gpu.run('reduce_sum', { inputs: { data }, outputs: { result: 1 } });
const max = await gpu.run('reduce_max', { inputs: { data }, outputs: { result: 1 } });
const min = await gpu.run('reduce_min', { inputs: { data }, outputs: { result: 1 } });

console.log(`Sum: ${sum.result[0]}, Min: ${min.result[0]}, Max: ${max.result[0]}`);
```

### Profiling & Auto-Tuning

Measure GPU performance and auto-tune workgroup size:

```js
const gpu = new GPUCompute();

// Profile a single op
const profile = await gpu.profile('multiply', {
  inputs: { a: new Float32Array(1024), b: new Float32Array(1024) },
  outputs: { result: 1024 },
});
console.log(profile); // { avg: 0.12, min: 0.11, max: 0.15, ... }

// Auto-tune workgroup size
const optimal = await gpu.autoTune('multiply', {
  inputs: { a: new Float32Array(1024), b: new Float32Array(1024) },
  outputs: { result: 1024 },
});
console.log(`Optimal workgroup size: ${optimal.workgroupSize}`);
```

---

## Framework Integration

### Hooks

Lifecycle-bound hooks for Preact/React.  The framework is resolved
automatically from your `thread.config.js`:

```jsx
import { useThread, usePool, useGPU } from 'thread';

// Thread hook — auto-creates and auto-destroys a thread
function DataProcessor({ data }) {
  const { run, loading, error, result } = useThread(
    (items) => items.map((x) => x * 2),
    { timeout: 10_000 }
  );

  return (
    <div>
      {loading && <Spinner />}
      {error && <Error message={error} />}
      {result && <Results data={result} />}
      <button onClick={() => run(data)} disabled={loading}>Process</button>
    </div>
  );
}

// Pool hook — metrics update automatically
function ParallelWorker({ items }) {
  const { run, status, metrics } = usePool(4, (item) => process(item));

  return (
    <div>
      <button onClick={() => items.forEach((item) => run(item))}>Process all</button>
      <p>{status().busy} threads busy</p>
      <p>Avg: {metrics.avg?.toFixed(1)}ms</p>
    </div>
  );
}

// GPU hook — reactive GPU state
function GPUDashboard() {
  const { run, result, loading, status } = useGPU();

  return (
    <div>
      <p>GPU: {status}</p>
      <button onClick={() => run('multiply', data1, data2)} disabled={loading}>
        {loading ? 'Computing...' : 'Run GPU'}
      </button>
      {result && <pre>{JSON.stringify(Array.from(result))}</pre>}
    </div>
  );
}
```

### Adapters

Bind threads/GPUs to your state manager.  Results flow automatically:

```js
import { create } from 'zustand';
import { createThread, createZustandBinder } from 'thread';

// Zustand store
const useStore = create((set) => ({
  data: null,
  error: null,
  setData: (data) => set({ data, error: null }),
  setError: (error) => set({ error }),
}));

// Thread + adapter
const thread = createThread((query) => db.query(query));
const binder = createZustandBinder(thread, useStore, 'setData', {
  errorAction: 'setError',
});

// Every run() result flows to the store
await binder.run('SELECT * FROM users');
// → useStore.getState().data is now the result
```

---

## Error Handling

```js
import {
  ThreadError,
  ThreadTimeoutError,
  ThreadAbortError,
  ThreadTerminatedError,
  ThreadHealthError,
  ThreadDependencyError,
  GPUComputeError,
} from 'thread';

try {
  await thread.run(data);
} catch (err) {
  if (err instanceof ThreadTimeoutError) {
    console.error('Task timed out');
  } else if (err instanceof ThreadAbortError) {
    console.error('Task was aborted');
  } else if (err instanceof GPUComputeError) {
    console.error('GPU failed:', err.message);
  } else {
    throw err; // re-throw non-thread errors
  }
}
```

| Error                    | When                                      |
|--------------------------|-------------------------------------------|
| `ThreadTimeoutError`     | Task exceeded its timeout                 |
| `ThreadAbortError`       | Task was aborted via AbortController      |
| `ThreadTerminatedError`  | Thread/pool was terminated                |
| `ThreadHealthError`      | Health check failed (internal)            |
| `ThreadDependencyError`  | A dependency task failed                  |
| `GPUComputeError`        | Shader compilation, buffer, or dispatch   |

---

## TypeScript

```ts
import type {
  // Thread & Pool
  ThreadDefinition,
  ThreadOptions,
  ThreadRunOptions,
  PoolOptions,
  PoolRunOptions,
  PoolTaskResult,
  PoolStatus,
  // GPU
  GPUComputeOptions,
  GPUComputeInput,
  GPUComputeSnapshot,
  OpDeclaration,
  // Hooks
  UseThreadReturn,
  UsePoolReturn,
  UseGPUReturn,
  UseGPURunReturn,
  // Adapters
  ZustandBinderOptions,
  SignalBinderOptions,
  StoreBinderOptions,
  BinderHandle,
  Signal,
  // Common
  MetricsSnapshot,
  ThreadEventName,
  // Config
  threadConfig,
  threadGPUConfig,
  threadThreadConfig,
  threadPoolConfig,
  threadDevConfig,
} from 'thread/types';
```

---

## Real-Life Use Cases

### 1. Financial Data Processing (Real-time EMA)

Compute Exponential Moving Averages on streaming price data using the GPU.
Processing 1M price ticks that would take seconds on CPU completes in
milliseconds on GPU:

```js
import { createGPUOp } from 'thread';

const gpu = createGPUOp('ema', (data, { alpha }) =>
  data.value * alpha + data.index * (1 - alpha)
);

// Process 1M price ticks in parallel
const prices = new Float32Array(priceTicks);
const ema = await gpu.run('ema', {
  inputs:   { data: prices },
  uniforms: { alpha: new Float32Array([0.1]) },
  outputs:  { result: prices.length },
});
```

### 2. Image Processing Pipeline

Process image pixels through a chain of filters without copying data
back to the CPU between steps:

```js
import { GPUCompute } from 'thread';

const gpu = new GPUCompute();
gpu.define('grayscale', (data) => data.value * 0.299 + data.value * 0.587 + data.value * 0.114);
gpu.define('contrast', (data, { factor }) => (data.value - 0.5) * factor + 0.5);
gpu.define('clamp01', (data) => Math.min(Math.max(data.value, 0), 1));

const output = await gpu.pipe(pixelData)
  .grayscale()
  .contrast({ factor: new Float32Array([1.2]) })
  .clamp01()
  .result();
```

### 3. Scientific Computing — Matrix Multiply

Multiply two matrices on the GPU.  The built-in `matmul` op handles
the tiling and parallel reduction automatically:

```js
import { GPUCompute } from 'thread';

const gpu = new GPUCompute();
const A = new Float32Array([1, 2, 3, 4, 5, 6]); // 2x3
const B = new Float32Array([7, 8, 9, 10, 11, 12]); // 3x2

const result = await gpu.run('matmul', {
  inputs:   { A, B },
  uniforms: {
    M: new Float32Array([2]),
    N: new Float32Array([2]),
    K: new Float32Array([3]),
  },
  outputs: { C: 4 },
});
// C = [58, 64, 139, 154]
```

### 4. Data Analytics — Histogram & Statistics

Build a histogram and find extremes in sensor data.  Three GPU passes
process millions of data points in parallel:

```js
import { createGPUReducer } from 'thread';

const gpu = createGPUReducer();
const sensorData = new Float32Array(sensorReadings);

// Find min, max, sum in parallel
const sum = await gpu.run('reduce_sum', { inputs: { data: sensorData }, outputs: { result: sensorData.length } });
const max = await gpu.run('reduce_max', { inputs: { data: sensorData }, outputs: { result: sensorData.length } });
const min = await gpu.run('reduce_min', { inputs: { data: sensorData }, outputs: { result: sensorData.length } });

const mean = sum.result[0] / sensorData.length;
```

### 5. Parallel File Processing (Thread Pool)

Process thousands of files across multiple workers.  The pool
automatically distributes work and handles failures:

```js
import { createPool } from 'thread';

const pool = createPool(8, async (filePath) => {
  const text = await fetch(filePath).then(r => r.text());
  return { path: filePath, wordCount: text.split(/\s+/).length };
});

const files = await glob('**/*.md');
const results = await Promise.all(
  files.map(f => pool.run(f).promise)
);

console.log(`Processed ${results.length} files`);
```

### 6. Real-Time Dashboard (React + Zustand)

Bind GPU compute results to a Zustand store for reactive UI updates.
The adapter handles the bridge between GPU and React state:

```jsx
import { create } from 'zustand';
import { createGPUOp, createGPUBinder } from 'thread';

const useStore = create((set) => ({
  metrics: null,
  setMetrics: (data) => set({ metrics: data }),
}));

const gpu = createGPUOp('normalize', (data, { mean, std }) =>
  (data.value - mean) / std
);

const binder = createGPUBinder(gpu, useStore, 'setMetrics');

// In a component — click triggers GPU compute, result flows to store
function Dashboard() {
  const metrics = useStore(s => s.metrics);
  return (
    <div>
      <button onClick={() => binder.run('normalize', { inputs: { data: rawData }, ... })}>
        Normalize
      </button>
      {metrics && <pre>{JSON.stringify(metrics)}</pre>}
    </div>
  );
}
```

### 7. WebGPU + CPU Fallback (Universal)

Gracefully fall back to CPU when WebGPU is unavailable.  Works on any
device — GPU if available, CPU otherwise:

```js
import { createGPUWithFallback } from 'thread';

const gpu = createGPUWithFallback(
  `@compute @workgroup_size(256) fn main(...) { ... }`,
  (input) => {
    // CPU fallback — same logic, slower
    const { data } = input.inputs;
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
    return { result };
  }
);

// Works on any device — GPU if available, CPU otherwise
const result = await gpu.computeWithFallback({
  inputs: { data: new Float32Array([1, 2, 3]) },
  outputBuffers: { result: 3 },
});
```

### 8. Search Engine — Parallel Indexing (React + Pool)

Build a search index by processing documents in parallel across a thread
pool, with real-time progress in the UI:

```jsx
import { createPool, usePool, usePoolMetrics } from 'thread';

// Create pool outside component (shared across renders)
const indexPool = createPool(4, async (doc) => {
  const tokens = tokenize(doc.content);
  const embeddings = await computeEmbeddings(tokens);
  return { id: doc.id, tokens, embeddings };
});

function SearchIndexer({ documents }) {
  const { run, status } = usePool(indexPool);
  const metrics = usePoolMetrics(indexPool, 500);

  const handleIndex = () => {
    documents.forEach((doc) => run(doc));
  };

  return (
    <div>
      <button onClick={handleIndex}>Index {documents.length} docs</button>
      <p>{status().busy}/{status().total} workers busy</p>
      <p>{metrics.count}/{documents.length} indexed</p>
      <p>{metrics.throughput?.toFixed(0)} docs/sec</p>
    </div>
  );
}
```

---

## API Reference

### Classes

| Class | Description |
|-------|-------------|
| `Thread` | Single Web Worker with full lifecycle |
| `ThreadPool` | Worker pool with priorities, deps, work-stealing |
| `GPUCompute` | WebGPU compute shader executor |
| `PipelineChain` | Fluent multi-step GPU pipeline |
| `DataPipelineChain` | Data-carrying pipeline with named methods |
| `Metrics` | Performance counter (avg, throughput, errors) |
| `Serializer` | JSON-safe serialization with function support |

### Factories

| Function | Description |
|----------|-------------|
| `createThread(def, opts)` | Create a validated thread |
| `createPool(size, def, opts)` | Create a validated pool |
| `createWorker(fn, opts)` | One-liner thread with error logging |
| `createWorkerDef(def)` | Reusable worker definition |
| `createManagedThread(def, opts)` | Thread with auto logging, metrics, health |
| `createGPUCompute(opts)` | Create a GPU instance |
| `createGPUOp(name, fn, opts)` | GPU with a single JS-defined op |
| `createGPUPipeline(ops, opts)` | GPU with multiple pre-registered ops |
| `createGPUReducer(opts)` | GPU ready for reductions |
| `createGPUWithFallback(shader, fn, opts)` | GPU with CPU fallback |

### Hooks

| Hook | Description |
|------|-------------|
| `useThread(def, opts)` | Lifecycle-bound thread with reactive state |
| `usePool(size, def, opts)` | Lifecycle-bound pool with metrics |
| `useThreadMetrics(thread, ms)` | Poll thread metrics |
| `usePoolMetrics(pool, ms)` | Poll pool metrics |
| `useThreadWorker(thread)` | Stable `run` for external thread |
| `useThreadEvent(thread, event, handler)` | Subscribe to thread events |
| `useGPU(opts)` | Lifecycle-bound GPU with reactive state |
| `useGPURun(gpu)` | Stable `run` for external GPU |
| `useGPUMetrics(gpu, ms)` | Poll GPU metrics |
| `useGPUStatus(gpu, ms)` | Reactive GPU status string |

### Adapters

| Function | Description |
|----------|-------------|
| `createZustandBinder(thread, store, action, opts)` | Bind thread → Zustand |
| `createSignalBinder(thread, signal, opts)` | Bind thread → Signal |
| `createStoreBinder(thread, setter, opts)` | Bind thread → any setter |
| `createPoolBinder(pool, setter, opts)` | Bind pool → any setter |
| `createGPUBinder(gpu, store, action, opts)` | Bind GPU → Zustand |
| `createGPUSignalBinder(gpu, signal, opts)` | Bind GPU → Signal |
| `createGPUStoreBinder(gpu, setter, opts)` | Bind GPU → any setter |

### Config

| Function | Description |
|----------|-------------|
| `defineConfig(config)` | Create a validated, frozen config object |
| `getConfig()` | Get the resolved config (cached) |
| `setConfig()` | Clear caches and force re-resolution |

### Errors

| Error | When |
|-------|------|
| `ThreadError` | Base class for all threads errors |
| `ThreadTimeoutError` | Task exceeded its timeout |
| `ThreadAbortError` | Task was aborted |
| `ThreadTerminatedError` | Thread/pool was terminated |
| `ThreadHealthError` | Health check failed |
| `ThreadDependencyError` | A dependency task failed |
| `GPUComputeError` | GPU shader, buffer, or dispatch failure |

---

## License

MIT — Peach LLC
