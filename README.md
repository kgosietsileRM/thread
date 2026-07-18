# sewt

**Enterprise Web Worker & GPU Compute Framework**

A modular, feature-rich library for running CPU-intensive work in **Web Workers** and **WebGPU compute shaders**. Includes a thread pool with work-stealing, dependency tracking, health checks, 57+ built-in GPU operations, and framework adapters for Preact, React, Zustand, and Preact Signals.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
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
  - [Preact / React Hooks](#preact--react-hooks)
  - [Zustand Adapter](#zustand-adapter)
  - [Preact Signals Adapter](#preact-signals-adapter)
  - [Generic Store Adapter](#generic-store-adapter)
- [Error Handling](#error-handling)
- [TypeScript](#typescript)
- [Real-Life Use Cases](#real-life-use-cases)
- [API Reference](#api-reference)

---

## Installation

```bash
npm install sewt
# or
bun add sewt
```

Peer dependency (optional — only needed for hooks):
```bash
npm install preact
```

---

## Quick Start

### CPU Workers

```js
import { createThread, createPool } from 'sewt';

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
import { createGPUOp } from 'sewt';

// Define a GPU operation from a plain JS function
const gpu = createGPUOp('double', (data) => data.value * 2);

const result = await gpu.run('double', {
  inputs: { data: new Float32Array([1, 2, 3]) },
  outputs: { result: 3 },
});
console.log(result.result); // Float32Array [2, 4, 6]
```

---

## Architecture

```
sewt
├── Thread              Single worker with full lifecycle management
├── ThreadPool          Pool with priority queue, deps, work-stealing
├── GPUCompute          WebGPU compute shader executor
│   ├── PipelineChain       Fluent multi-step GPU pipelines
│   ├── DataPipelineChain   Data-carrying pipelines with named methods
│   └── 57+ built-in ops    multiply, sqrt, ema, reduce_sum, matmul, …
├── Metrics             Performance counters (avg, throughput, errors)
├── Serializer          JSON-safe serialization with function support
├── Errors              Typed error hierarchy (timeout, abort, GPU, …)
├── Factories           createThread, createPool, createGPUOp, …
├── Hooks               useThread, usePool, useGPU (Preact/React)
└── Adapters            Zustand, Signals, generic store bindings
```

---

## CPU Workers

### Single Thread

```js
import { createThread } from 'sewt';

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
```

### Thread Pool

```js
import { createPool } from 'sewt';

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

```js
import { createThread } from 'sewt';

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

for await (const partial of t.runStreaming(data, 100)) {
  renderProgress(partial);
}
```

### Function Chaining

Pipe a value through a sequence of functions, each in its own worker:

```js
const t = createThread((x) => x);

const result = await t.runChain(
  10,
  (x) => x + 5,    // 15
  (x) => x * 2,    // 30
  (x) => x - 3,    // 27
);
// 27
```

---

## GPU Compute

### One-Liner Ops

Define GPU operations from plain JavaScript functions. The function is automatically transpiled to WGSL for the GPU and also serves as the CPU fallback when WebGPU is unavailable.

```js
import { createGPUOp } from 'sewt';

// EMA (Exponential Moving Average)
const gpu = createGPUOp('ema', (data, { alpha }) =>
  data.value * alpha + data.index * (1 - alpha)
);

const prices = new Float32Array([100, 102, 101, 105, 107]);
const result = await gpu.run('ema', {
  inputs:   { data: prices },
  uniforms: { alpha: new Float32Array([0.3]) },
  outputs:  { result: 5 },
});
// result.result → Float32Array of EMA values
```

**Available proxies inside the function:**

| Proxy         | Meaning                           |
|---------------|-----------------------------------|
| `data.value`  | Current element (maps to `input[i]`) |
| `data.index`  | Current index (integer)           |
| `data.i`      | Same as `data.index`              |

### Multi-Op Pipelines

Register multiple operations on a single GPU instance:

```js
import { createGPUPipeline } from 'sewt';

const gpu = createGPUPipeline([
  ['ema',    (data, { alpha }) => data.value * alpha],
  ['double', (data) => data.value * 2],
  ['negate', (data) => -data.value],
  ['sqrt',   (data) => Math.sqrt(Math.abs(data.value))],
]);

// Run any of them
await gpu.run('ema', { inputs: { data }, uniforms: { alpha: new Float32Array([0.5]) }, outputs: { result: 5 } });
await gpu.run('double', { inputs: { data }, outputs: { result: 5 } });
```

### Built-in Operations

57+ operations available out of the box — no shader code needed:

| Category    | Operations |
|-------------|-----------|
| Arithmetic  | `add`, `subtract`, `multiply`, `divide`, `power`, `square`, `reciprocal`, `negate` |
| Math        | `sqrt`, `abs`, `sin`, `cos`, `tan`, `exp`, `log`, `floor`, `ceil`, `round`, `fract`, `sign`, `cbrt` |
| Comparison  | `min`, `max`, `clamp`, `equal`, `notEqual`, `greaterThan`, `lessThan`, `select` |
| Interpolation | `lerp`, `normalize`, `scaleOffset` |
| Signal      | `copy`, `fill` |
| Reduction   | `reduce_sum`, `reduce_min`, `reduce_max` |
| Special     | `matmul`, `histogram`, `argmax`, `argmin`, `scan` |

```js
import { createGPUReducer } from 'sewt';

const gpu = createGPUReducer();
const data = new Float32Array([1, 2, 3, 4, 5]);

const sum = await gpu.run('reduce_sum', { inputs: { data }, outputs: { result: 5 } });
console.log(sum.result); // Float32Array([15])
```

### Pipeline Chaining

Chain operations sequentially — each step's output feeds the next:

```js
import { GPUCompute } from 'sewt';

const gpu = new GPUCompute();
gpu.define('ema', (data, { alpha }) => data.value * alpha);
gpu.define('double', (data) => data.value * 2);

// Chain API
const chain = gpu.pipe()
  .add('ema', { inputs: { data: prices }, uniforms: { alpha: new Float32Array([0.3]) } })
  .add('double');

const output = await chain.result();
```

### Fluent Data Pipelines

Carry data through a chain with named methods (Proxy-based):

```js
const gpu = new GPUCompute();
gpu.define('ema', (data, { alpha }) => data.value * alpha);
gpu.define('double', (data) => data.value * 2);

// Data-carrying chain — data flows automatically
const output = await gpu.pipe(new Float32Array([1, 2, 3]))
  .ema({ alpha: 0.3 })
  .double()
  .result();
```

### Map (Parallel Transform)

Apply a function to every element in parallel on the GPU:

```js
const gpu = new GPUCompute();
const result = await gpu.map(
  new Float32Array([1, 4, 9, 16]),
  (x) => Math.sqrt(x)
);
// result → Float32Array([1, 2, 3, 4])
```

### Reductions

Sum, min, max over large arrays using GPU-accelerated parallel reduction:

```js
import { createGPUReducer } from 'sewt';

const gpu = createGPUReducer();
const data = new Float32Array(Array.from({ length: 1_000_000 }, () => Math.random()));

const sum = await gpu.run('reduce_sum', { inputs: { data }, outputs: { result: 1_000_000 } });
const max = await gpu.run('reduce_max', { inputs: { data }, outputs: { result: 1_000_000 } });
const min = await gpu.run('reduce_min', { inputs: { data }, outputs: { result: 1_000_000 } });
```

### Profiling & Auto-Tuning

```js
const gpu = new GPUCompute();
gpu.define('myOp', (data) => data.value * 2);

// Profile a multi-step pipeline
const profile = await gpu.profile([
  { name: 'myOp', input: { inputs: { data: new Float32Array(1024) }, outputs: { result: 1024 } } },
]);
console.log(profile.steps);  // [{ name: 'myOp', ms: 0.42 }]
console.log(profile.totalMs); // 0.42

// Auto-tune workgroup size
const { optimal, results } = await gpu.autoTune('myOp', {
  inputs: { data: new Float32Array(1024) },
  outputs: { result: 1024 },
});
console.log(`Optimal workgroup size: ${optimal}`);
```

---

## Framework Integration

### Preact / React Hooks

```jsx
import { useGPU, useThread, usePool, useGPUMetrics } from 'sewt';

// GPU hook — lifecycle-bound with reactive state
function GPUDemo({ prices }) {
  const { run, result, loading, error, status } = useGPU();

  return (
    <div>
      <p>GPU: {status}</p>
      <button onClick={() => run('ema', { inputs: { data: prices }, ... })} disabled={loading}>
        {loading ? 'Computing...' : 'Run EMA'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// Thread hook
function DataProcessor({ input }) {
  const { run, result, loading, error } = useThread(
    (data) => heavyCompute(data),
    { timeout: 10_000 }
  );

  return (
    <button onClick={() => run(input)} disabled={loading}>
      {loading ? 'Processing...' : 'Run'}
    </button>
  );
}

// Pool hook
function WorkerPool() {
  const { run, status, metrics } = usePool(4, heavyComputation);
  return (
    <div>
      <p>{status().busy}/4 threads busy</p>
      <p>Avg: {metrics.avg?.toFixed(1)}ms</p>
    </div>
  );
}
```

### Zustand Adapter

```js
import { create } from 'zustand';
import { createGPUBinder } from 'sewt';

const useStore = create((set) => ({
  result: null,
  loading: false,
  error: null,
  setData: (data) => set({ result: data, loading: false }),
  setError: (err) => set({ error: err, loading: false }),
  setLoading: () => set({ loading: true, error: null }),
}));

const binder = createGPUBinder(gpu, useStore, 'setData', {
  errorAction: 'setError',
});

await binder.run('ema', { inputs: { data: prices }, ... });
// useStore.getState().result is updated automatically
```

### Preact Signals Adapter

```js
import { signal } from '@preact/signals';
import { createGPUSignalBinder } from 'sewt';

const dataSignal = signal(null);
const errorSignal = signal(null);
const loadingSignal = signal(false);

const binder = createGPUSignalBinder(gpu, dataSignal, {
  errorSignal,
  loadingSignal,
});

await binder.run('ema', { inputs: { data: prices }, ... });
console.log(dataSignal.value); // Float32Array result
```

### Generic Store Adapter

Works with MobX, Redux, Vue refs, Svelte stores, or plain `setState`:

```js
import { createGPUStoreBinder } from 'sewt';

const binder = createGPUStoreBinder(gpu, setData, {
  onError: (err) => console.error(err),
  onMetrics: (snap) => updateDashboard(snap),
});

await binder.run('ema', { inputs: { data: prices }, ... });
```

---

## Error Handling

All errors extend `ThreadError`. Catch the base class for generic handling, or catch specific subclasses:

```js
import {
  ThreadError, ThreadTimeoutError, ThreadAbortError,
  GPUComputeError,
} from 'sewt';

try {
  await gpu.run('myOp', input);
} catch (err) {
  if (err instanceof GPUComputeError) {
    console.error(`GPU failed: ${err.message}`);
    if (err.cause) console.error('Original:', err.cause);
  } else if (err instanceof ThreadTimeoutError) {
    console.error('Task took too long');
  } else if (err instanceof ThreadError) {
    console.error('Worker error:', err.message);
  } else {
    throw err; // re-throw non-sewt errors
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
} from 'sewt/types';
```

---

## Real-Life Use Cases

### 1. Financial Data Processing (Real-time EMA)

Compute Exponential Moving Averages on streaming price data using the GPU:

```js
import { createGPUOp } from 'sewt';

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

Process image pixels through a chain of filters:

```js
import { GPUCompute } from 'sewt';

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

Multiply two matrices on the GPU:

```js
import { GPUCompute } from 'sewt';

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

Build a histogram and find extremes in sensor data:

```js
import { createGPUReducer } from 'sewt';

const gpu = createGPUReducer();
const sensorData = new Float32Array(sensorReadings);

// Find min, max, sum in parallel
const sum = await gpu.run('reduce_sum', { inputs: { data: sensorData }, outputs: { result: sensorData.length } });
const max = await gpu.run('reduce_max', { inputs: { data: sensorData }, outputs: { result: sensorData.length } });
const min = await gpu.run('reduce_min', { inputs: { data: sensorData }, outputs: { result: sensorData.length } });

const mean = sum.result[0] / sensorData.length;
```

### 5. Parallel File Processing (Thread Pool)

Process thousands of files across multiple workers:

```js
import { createPool } from 'sewt';

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

### 6. Real-Time Dashboard (Preact + Zustand)

Bind GPU compute results to a Zustand store for reactive UI updates:

```jsx
import { create } from 'zustand';
import { createGPUOp, createGPUBinder } from 'sewt';

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

Gracefully fall back to CPU when WebGPU is unavailable:

```js
import { createGPUWithFallback } from 'sewt';

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

### Hooks (Preact / React)

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

### Errors

| Error | When |
|-------|------|
| `ThreadError` | Base class for all threats errors |
| `ThreadTimeoutError` | Task exceeded its timeout |
| `ThreadAbortError` | Task was aborted |
| `ThreadTerminatedError` | Thread/pool was terminated |
| `ThreadHealthError` | Health check failed |
| `ThreadDependencyError` | A dependency task failed |
| `GPUComputeError` | GPU shader, buffer, or dispatch failure |

---

## License

MIT — Peach LLC
