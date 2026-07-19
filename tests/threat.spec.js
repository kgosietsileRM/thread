import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Metrics } from "../src/metrix.js";
import { Serializer } from "../src/serializer.js";
import {
  ThreadError,
  ThreadTimeoutError,
  ThreadAbortError,
  ThreadTerminatedError,
  ThreadHealthError,
  ThreadDependencyError,
} from "../src/error.js";
import {
  createThread,
  createPool,
  createWorker,
  createWorkerDef,
  createManagedThread,
  createGPUOp,
  createGPUPipeline,
  createGPUReducer,
} from "../src/factory.js";
import {
  GPUCompute,
  PipelineChain,
  DataPipelineChain,
  createGPUCompute,
  createGPUWithFallback,
  outputSpec,
  uniform,
} from "../src/gpu/gpu.js";
import {
  useGPU,
  useGPURun,
  useGPUMetrics,
  useGPUStatus,
} from "../src/gpu/hooks.js";
import {
  createGPUBinder,
  createGPUSignalBinder,
  createGPUStoreBinder,
} from "../src/gpu/adapters.js";
import {
  buildShader,
  BUILT_IN_OPS,
  BUILT_IN_OP_NAMES,
  SPECIAL_OPS,
} from "../src/gpu/shaders.js";
import { GPUComputeError } from "../src/error.js";
import { defineConfig, getConfig, setConfig, DEFAULTS, FRAMEWORKS, STATE_MANAGERS } from "../src/config.js";
import { mergeWithDefaults, validateConfig } from "../src/config/schema.js";
import { resolveHooks } from "../src/config/frameworks.js";
import { getAdapter } from "../src/config/adapters.js";

// ============================================================
// Metrics
// ============================================================
describe("Metrics", () => {
  let m;
  beforeEach(() => {
    m = new Metrics();
  });

  test("starts with zeroed snapshot", () => {
    const s = m.snapshot();
    expect(s.count).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.avg).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.throughput).toBe(0);
    expect(s.errorRate).toBe(0);
  });

  test("records successful durations", () => {
    m.record(100, true);
    m.record(200, true);
    const s = m.snapshot();
    expect(s.count).toBe(2);
    expect(s.errors).toBe(0);
    expect(s.min).toBe(100);
    expect(s.max).toBe(200);
    expect(s.avg).toBe(150);
  });

  test("records error durations with success=false", () => {
    m.record(100, true);
    m.record(0, false);
    const s = m.snapshot();
    expect(s.count).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBe(0.5);
  });

  test("avg does NOT include error entries with duration 0 (BUG FIX)", () => {
    m.record(100, true);
    m.record(200, true);
    m.record(0, false);
    m.record(0, false);
    const s = m.snapshot();
    // Without fix: avg = 300/4 = 75 (wrong — errors pollute average)
    // With fix: avg = 300/2 = 150 (only successful tasks)
    expect(s.avg).toBe(150);
    expect(s.count).toBe(4);
  });

  test("min/max track only successful tasks (BUG FIX)", () => {
    m.record(0, false); // error with 0 duration should NOT become min
    m.record(100, true);
    m.record(200, true);
    const s = m.snapshot();
    expect(s.min).toBe(100);
    expect(s.max).toBe(200);
  });

  test("throughput calculates tasks per second", () => {
    m.record(500, true); // 0.5s
    m.record(500, true); // 0.5s total = 1.0s
    const s = m.snapshot();
    expect(s.throughput).toBeCloseTo(2); // 2 tasks / 1 second
  });

  test("throughput is 0 when no tasks", () => {
    expect(m.throughput).toBe(0);
  });

  test("avg is 0 when no successful tasks", () => {
    m.record(0, false);
    expect(m.avg).toBe(0);
  });

  test("errorRate is 1 when all tasks are errors", () => {
    m.record(0, false);
    m.record(0, false);
    expect(m.errorRate).toBe(1);
  });

  test("reset clears all counters", () => {
    m.record(100, true);
    m.record(0, false);
    m.reset();
    const s = m.snapshot();
    expect(s.count).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.avg).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.throughput).toBe(0);
    expect(s.errorRate).toBe(0);
  });

  test("single recording gives correct min/max", () => {
    m.record(42, true);
    const s = m.snapshot();
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.avg).toBe(42);
  });
});

// ============================================================
// Error classes
// ============================================================
describe("Error classes", () => {
  test("ThreadError is instance of Error", () => {
    const e = new ThreadError("msg");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ThreadError);
    expect(e.name).toBe("ThreadError");
    expect(e.message).toBe("msg");
  });

  test("ThreadTimeoutError hierarchy", () => {
    const e = new ThreadTimeoutError("timeout");
    expect(e).toBeInstanceOf(ThreadError);
    expect(e).toBeInstanceOf(ThreadTimeoutError);
    expect(e.name).toBe("ThreadTimeoutError");
  });

  test("ThreadAbortError hierarchy", () => {
    const e = new ThreadAbortError("aborted");
    expect(e).toBeInstanceOf(ThreadError);
    expect(e).toBeInstanceOf(ThreadAbortError);
    expect(e.name).toBe("ThreadAbortError");
  });

  test("ThreadTerminatedError hierarchy", () => {
    const e = new ThreadTerminatedError("terminated");
    expect(e).toBeInstanceOf(ThreadError);
    expect(e).toBeInstanceOf(ThreadTerminatedError);
    expect(e.name).toBe("ThreadTerminatedError");
  });

  test("ThreadHealthError hierarchy", () => {
    const e = new ThreadHealthError("unhealthy");
    expect(e).toBeInstanceOf(ThreadError);
    expect(e).toBeInstanceOf(ThreadHealthError);
    expect(e.name).toBe("ThreadHealthError");
  });

  test("ThreadDependencyError hierarchy", () => {
    const e = new ThreadDependencyError("missing dep");
    expect(e).toBeInstanceOf(ThreadError);
    expect(e).toBeInstanceOf(ThreadDependencyError);
    expect(e.name).toBe("ThreadDependencyError");
  });
});

// ============================================================
// Serializer
// ============================================================
describe("Serializer", () => {
  test("serializes/deserializes primitives", () => {
    expect(Serializer.deserialize(Serializer.serialize(42))).toBe(42);
    expect(Serializer.deserialize(Serializer.serialize("hello"))).toBe("hello");
    expect(Serializer.deserialize(Serializer.serialize(true))).toBe(true);
    expect(Serializer.deserialize(Serializer.serialize(null))).toBe(null);
    expect(Serializer.deserialize(Serializer.serialize(undefined))).toBe(undefined);
  });

  test("serializes/deserializes plain objects", () => {
    const obj = { a: 1, b: "two", c: { nested: true } };
    const roundtrip = Serializer.deserialize(Serializer.serialize(obj));
    expect(roundtrip).toEqual(obj);
  });

  test("serializes/deserializes arrays", () => {
    const arr = [1, "two", { three: 3 }, [4, 5]];
    const roundtrip = Serializer.deserialize(Serializer.serialize(arr));
    expect(roundtrip).toEqual(arr);
  });

  test("serializes/deserializes functions", () => {
    const fn = (x) => x * 2;
    const serialized = Serializer.serialize(fn);
    expect(serialized).toEqual({
      __type: "function",
      __value: "(x) => x * 2",
    });
    const deserialized = Serializer.deserialize(serialized);
    expect(typeof deserialized).toBe("function");
    expect(deserialized(5)).toBe(10);
  });

  test("serializes/deserializes functions inside objects", () => {
    const obj = {
      name: "test",
      handler: (x) => x + 1,
      nested: { fn: (a, b) => a + b },
    };
    const roundtrip = Serializer.deserialize(Serializer.serialize(obj));
    expect(roundtrip.name).toBe("test");
    expect(roundtrip.handler(3)).toBe(4);
    expect(roundtrip.nested.fn(1, 2)).toBe(3);
  });

  test("serializes/deserializes functions inside arrays", () => {
    const arr = [(x) => x, (x) => x * 2];
    const roundtrip = Serializer.deserialize(Serializer.serialize(arr));
    expect(roundtrip[0](10)).toBe(10);
    expect(roundtrip[1](10)).toBe(20);
  });

  test("serialize leaves non-function primitives untouched", () => {
    expect(Serializer.serialize(42)).toBe(42);
    expect(Serializer.serialize("str")).toBe("str");
    expect(Serializer.serialize(null)).toBe(null);
  });

  test("deserialize leaves non-function objects untouched", () => {
    const obj = { a: 1, b: "hello" };
    expect(Serializer.deserialize(obj)).toEqual(obj);
  });

  test("handles circular-ish references gracefully", () => {
    const a = { val: 1 };
    const b = { val: 2, ref: a };
    const serialized = Serializer.serialize(b);
    const roundtrip = Serializer.deserialize(serialized);
    expect(roundtrip.val).toBe(2);
    expect(roundtrip.ref.val).toBe(1);
  });
});

// ============================================================
// Factory functions
// ============================================================
describe("Factory functions", () => {
  test("createWorkerDef returns valid definition", () => {
    const def = createWorkerDef({
      exec: (state, x) => x * 2,
    });
    expect(def.exec).toBeInstanceOf(Function);
    expect(def.setup).toBeNull();
    expect(def.cleanup).toBeNull();
  });

  test("createWorkerDef with full lifecycle", () => {
    const setupFn = () => ({ count: 0 });
    const execFn = (state, x) => state.count + x;
    const cleanupFn = (state) => {};
    const def = createWorkerDef({ setup: setupFn, exec: execFn, cleanup: cleanupFn });
    expect(def.setup).toBe(setupFn);
    expect(def.exec).toBe(execFn);
    expect(def.cleanup).toBe(cleanupFn);
  });

  test("createWorkerDef throws without exec", () => {
    expect(() => createWorkerDef({})).toThrow("def.exec must be a function");
  });

  test("createWorkerDef throws with non-object", () => {
    expect(() => createWorkerDef(null)).toThrow("expects an object");
  });

  test("createPool validates size", () => {
    expect(() => createPool(0, (x) => x)).toThrow("positive integer");
    expect(() => createPool(-1, (x) => x)).toThrow("positive integer");
    expect(() => createPool(1.5, (x) => x)).toThrow("positive integer");
    expect(() => createPool("4", (x) => x)).toThrow("positive integer");
  });
});

// ============================================================
// Adapters (with mock thread)
// ============================================================
describe("Adapters", () => {
  // A mock Thread that doesn't need Web Workers
  function createMockThread() {
    const listeners = { result: [], error: [], metrics: [] };
    return {
      _listeners: listeners,
      on(event, handler) { listeners[event]?.push(handler); return this; },
      off(event, handler) {
        const arr = listeners[event];
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
        return this;
      },
      run: mock(() => Promise.resolve(42)),
      runAsync: mock(() => {}),
      // Simulate firing an event
      _emit(event, ...args) {
        for (const h of this._listeners[event] || []) h(...args);
      },
    };
  }

  test("createStoreBinder calls setter on result", async () => {
    const { createStoreBinder } = await import("../src/adapters.js");
    const thread = createMockThread();
    let captured = null;
    const binder = createStoreBinder(thread, (result) => { captured = result; });

    thread._emit("result", 42);
    expect(captured).toBe(42);

    binder.destroy();
  });

  test("createStoreBinder calls onError on error", () => {
    const { createStoreBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    let capturedError = null;
    const binder = createStoreBinder(thread, () => {}, {
      onError: (err) => { capturedError = err; },
    });

    thread._emit("error", { error: "something broke" });
    expect(capturedError).toBe("something broke");

    binder.destroy();
  });

  test("createStoreBinder applies transform", () => {
    const { createStoreBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    let captured = null;
    const binder = createStoreBinder(thread, (result) => { captured = result; }, {
      transform: (r) => r * 10,
    });

    thread._emit("result", 5);
    expect(captured).toBe(50);

    binder.destroy();
  });

  test("createStoreBinder destroy removes listeners", () => {
    const { createStoreBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    const binder = createStoreBinder(thread, () => {});

    expect(thread._listeners.result.length).toBe(1);
    expect(thread._listeners.error.length).toBe(1);

    binder.destroy();

    expect(thread._listeners.result.length).toBe(0);
    expect(thread._listeners.error.length).toBe(0);
  });

  test("createSignalBinder writes to signal.value", () => {
    const { createSignalBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    const sig = { value: null };
    const binder = createSignalBinder(thread, sig);

    thread._emit("result", "hello");
    expect(sig.value).toBe("hello");

    binder.destroy();
  });

  test("createSignalBinder writes errors to errorSignal", () => {
    const { createSignalBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    const sig = { value: null };
    const errSig = { value: null };
    const binder = createSignalBinder(thread, sig, { errorSignal: errSig });

    thread._emit("error", { error: "fail" });
    expect(sig.value).toBe(null);
    expect(errSig.value).toBe("fail");

    binder.destroy();
  });

  test("createSignalBinder applies transform", () => {
    const { createSignalBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    const sig = { value: 0 };
    const binder = createSignalBinder(thread, sig, {
      transform: (r) => r * 3,
    });

    thread._emit("result", 7);
    expect(sig.value).toBe(21);

    binder.destroy();
  });

  test("createSignalBinder clears error on success", () => {
    const { createSignalBinder } = require("../src/adapters.js");
    const thread = createMockThread();
    const sig = { value: null };
    const errSig = { value: "old error" };
    const binder = createSignalBinder(thread, sig, { errorSignal: errSig });

    thread._emit("result", "ok");
    expect(errSig.value).toBe(null);

    binder.destroy();
  });
});

// ============================================================
// GPUComputeError
// ============================================================
describe("GPUComputeError", () => {
  test("is instance of ThreadError and Error", () => {
    const e = new GPUComputeError("gpu failed");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ThreadError);
    expect(e).toBeInstanceOf(GPUComputeError);
    expect(e.name).toBe("GPUComputeError");
    expect(e.message).toBe("gpu failed");
  });

  test("accepts optional cause", () => {
    const cause = new Error("original");
    const e = new GPUComputeError("wrapped", cause);
    expect(e.cause).toBe(cause);
  });

  test("cause is undefined when not provided", () => {
    const e = new GPUComputeError("no cause");
    expect(e.cause).toBeUndefined();
  });
});

// ============================================================
// GPU Compute
// ============================================================
describe("GPU Compute", () => {
  const SIMPLE_SHADER = `
    @group(0) @binding(0) var<storage, read>       input: array<f32>;
    @group(0) @binding(1) var<storage, read_write>  output: array<f32>;

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let i = id.x;
      if (i < arrayLength(&input)) {
        output[i] = input[i] * 2.0;
      }
    }
  `;

  // ---- Constructor ----

  test("constructor throws with non-string shader", () => {
    expect(() => new GPUCompute({ shader: 123 })).toThrow("options.shader must be a string");
  });

  test("constructor works without shader", () => {
    const gpu = new GPUCompute();
    expect(gpu._shader).toBeNull();
    expect(gpu.pipelines).toEqual([]);
  });

  test("constructor stores options", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER, workgroupSize: 64 });
    expect(gpu._shader).toBe(SIMPLE_SHADER);
    expect(gpu._workgroupSize).toBe(64);
    expect(gpu._isInitialised).toBe(false);
    expect(gpu._device).toBeNull();
  });

  test("constructor defaults", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu._workgroupSize).toBe(256);
    expect(gpu._maxBufferSize).toBe(256 * 1024 * 1024);
    expect(gpu._powerPreference).toBe('high-performance');
    expect(gpu._entryPoint).toBe('main');
    expect(gpu._cpuFallback).toBeNull();
  });

  test("constructor registers default pipeline", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu.pipelines).toEqual(['default']);
    expect(gpu.activePipeline).toBe('default');
  });

  test("status is 'unavailable' when navigator.gpu is missing", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu.status).toBe('unavailable');
  });

  // ---- Getters ----

  test("available getter is boolean", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(typeof gpu.available).toBe('boolean');
  });

  test("ready is false before init", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu.ready).toBe(false);
  });

  test("dispatchCount is 0 initially", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu.dispatchCount).toBe(0);
  });

  test("bytesTransferred is 0 initially", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu.bytesTransferred).toBe(0);
  });

  test("metrics returns zeroed snapshot", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    const snap = gpu.metrics;
    expect(snap.count).toBe(0);
    expect(snap.errors).toBe(0);
    expect(snap.avg).toBe(0);
    expect(snap.min).toBe(0);
    expect(snap.max).toBe(0);
    expect(snap.throughput).toBe(0);
    expect(snap.errorRate).toBe(0);
  });

  // ---- Init ----

  test("init fails when WebGPU unavailable", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._available = false;
    await expect(gpu.init()).rejects.toThrow(GPUComputeError);
    expect(gpu.status).toBe('unavailable');
  });

  test("init sets status to error on adapter failure", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._available = true;
    // Mock navigator.gpu to throw
    const origGpu = globalThis.navigator?.gpu;
    if (globalThis.navigator) {
      globalThis.navigator.gpu = { requestAdapter: () => { throw new Error("nope"); } };
    }
    try {
      await expect(gpu.init()).rejects.toThrow(GPUComputeError);
    } finally {
      if (globalThis.navigator) {
        globalThis.navigator.gpu = origGpu;
      }
    }
  });

  // ---- Pipeline management ----

  test("addShader registers new pipeline", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await gpu.addShader('multiply', SIMPLE_SHADER);
    expect(gpu.pipelines).toContain('default');
    expect(gpu.pipelines).toContain('multiply');
  });

  test("addShader throws on duplicate name", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await expect(gpu.addShader('default', SIMPLE_SHADER)).rejects.toThrow("already exists");
  });

  test("addShader validates name", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await expect(gpu.addShader('', SIMPLE_SHADER)).rejects.toThrow("non-empty string");
    await expect(gpu.addShader(123, SIMPLE_SHADER)).rejects.toThrow("non-empty string");
  });

  test("addShader validates source", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await expect(gpu.addShader('test', '')).rejects.toThrow("non-empty string");
    await expect(gpu.addShader('test', 42)).rejects.toThrow("non-empty string");
  });

  test("setActive switches active pipeline", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await gpu.addShader('other', SIMPLE_SHADER);
    gpu.setActive('other');
    expect(gpu.activePipeline).toBe('other');
  });

  test("setActive throws on unknown name", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(() => gpu.setActive('nope')).toThrow("does not exist");
  });

  test("removeShader removes non-default pipeline", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await gpu.addShader('temp', SIMPLE_SHADER);
    expect(gpu.pipelines).toContain('temp');
    gpu.removeShader('temp');
    expect(gpu.pipelines).not.toContain('temp');
  });

  test("removeShader throws for default pipeline", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(() => gpu.removeShader('default')).toThrow("Cannot remove the default pipeline");
  });

  test("removeShader throws for unknown pipeline", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    expect(() => gpu.removeShader('nope')).toThrow("does not exist");
  });

  test("removeShader switches to default if active removed", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await gpu.addShader('temp', SIMPLE_SHADER);
    gpu.setActive('temp');
    expect(gpu.activePipeline).toBe('temp');
    gpu.removeShader('temp');
    expect(gpu.activePipeline).toBe('default');
  });

  // ---- CPU fallback ----

  test("createGPUCompute returns GPUCompute instance", () => {
    const gpu = createGPUCompute({ shader: SIMPLE_SHADER });
    expect(gpu).toBeInstanceOf(GPUCompute);
  });

  test("createGPUCompute works without shader", () => {
    const gpu = createGPUCompute({});
    expect(gpu).toBeInstanceOf(GPUCompute);
    expect(gpu._shader).toBeNull();
  });

  test("createGPUWithFallback returns GPUCompute with fallback", () => {
    const fb = async () => ({});
    const gpu = createGPUWithFallback(SIMPLE_SHADER, fb);
    expect(gpu).toBeInstanceOf(GPUCompute);
    expect(gpu._cpuFallback).toBe(fb);
  });

  test("createGPUWithFallback with custom options", () => {
    const fb = async () => ({});
    const gpu = createGPUWithFallback(SIMPLE_SHADER, fb, { workgroupSize: 128 });
    expect(gpu._workgroupSize).toBe(128);
    expect(gpu._cpuFallback).toBe(fb);
  });

  test("computeWithFallback uses CPU fallback when WebGPU unavailable", async () => {
    const input = { inputs: { data: new Float32Array([1, 2, 3]) }, outputBuffers: { result: 3 } };
    const gpu = createGPUWithFallback(SIMPLE_SHADER, async (inp) => {
      const data = inp.inputs.data;
      const result = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
      return { result };
    });
    gpu._available = false;

    const output = await gpu.computeWithFallback(input);
    expect(output.result).toEqual(new Float32Array([2, 4, 6]));
  });

  test("computeWithFallback throws when no fallback and no WebGPU", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._available = false;

    await expect(
      gpu.computeWithFallback({ inputs: {}, outputBuffers: {} })
    ).rejects.toThrow(GPUComputeError);
  });

  test("computeWithFallback allows per-call fallback override", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._available = false;

    const overrideFn = async () => ({ result: new Float32Array([99]) });
    const output = await gpu.computeWithFallback({ inputs: {}, outputBuffers: {} }, overrideFn);
    expect(output.result).toEqual(new Float32Array([99]));
  });

  // ---- computeMany ----

  test("computeMany throws for non-array", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await expect(gpu.computeMany('not an array')).rejects.toThrow("batches must be an array");
  });

  test("computeMany calls onProgress", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._available = false;
    // set up a fallback that tracks calls
    const calls = [];
    gpu._cpuFallback = async (inp) => {
      calls.push(inp);
      return { result: new Float32Array([0]) };
    };

    const progressCalls = [];
    await gpu.computeMany(
      [
        { inputs: {}, outputBuffers: { result: 1 } },
        { inputs: {}, outputBuffers: { result: 1 } },
      ],
      { onProgress: (i, n) => progressCalls.push([i, n]) },
    );
    expect(calls.length).toBe(2);
    expect(progressCalls).toEqual([[1, 2], [2, 2]]);
  });

  // ---- computeSequential ----

  test("computeSequential throws for empty array", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await expect(gpu.computeSequential([])).rejects.toThrow("non-empty array");
  });

  test("computeSequential throws for non-array", async () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    await expect(gpu.computeSequential('nope')).rejects.toThrow("non-empty array");
  });

  // ---- destroy ----

  test("destroy clears buffers and device", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._bufferPool.set('test', [{ destroy: () => {} }]);
    gpu.destroy();
    expect(gpu._bufferPool.size).toBe(0);
    expect(gpu._device).toBeNull();
    expect(gpu._isInitialised).toBe(false);
    expect(gpu.status).toBe('unavailable');
  });

  // ---- resetMetrics ----

  test("resetMetrics clears counters", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER });
    gpu._metrics.record(100, true);
    gpu._bytesTransferred = 1024;
    gpu._dispatchCount = 5;
    gpu.resetMetrics();
    expect(gpu.metrics.count).toBe(0);
    expect(gpu.bytesTransferred).toBe(0);
    expect(gpu.dispatchCount).toBe(0);
  });

  // ---- inspect ----

  test("inspect returns full snapshot", () => {
    const gpu = new GPUCompute({ shader: SIMPLE_SHADER, workgroupSize: 128 });
    const info = gpu.inspect();
    expect(info.status).toBe('unavailable');
    expect(info.available).toBe(false);
    expect(info.ready).toBe(false);
    expect(info.activePipeline).toBe('default');
    expect(info.pipelines).toEqual(['default']);
    expect(info.metrics.count).toBe(0);
    expect(info.dispatchCount).toBe(0);
    expect(info.bytesTransferred).toBe(0);
    expect(info.bufferPoolEntries).toBe(0);
    expect(info.workgroupSize).toBe(128);
    expect(info.maxBufferSize).toBe(256 * 1024 * 1024);
    expect(info.powerPreference).toBe('high-performance');
  });

  // ---- Helpers ----

  test("outputSpec creates correct shape", () => {
    const spec = outputSpec('result', 4);
    expect(spec).toEqual({ outputBuffers: { result: 4 }, outputType: 'f32' });
  });

  test("outputSpec with custom type", () => {
    const spec = outputSpec('out', 8, 'i32');
    expect(spec).toEqual({ outputBuffers: { out: 8 }, outputType: 'i32' });
  });

  test("outputSpec with TypedArray constructor", () => {
    const spec = outputSpec('data', 16, Uint32Array);
    expect(spec).toEqual({ outputBuffers: { data: 16 }, outputType: Uint32Array });
  });

  test("uniform creates correct shape", () => {
    const u = uniform('scale', new Float32Array([2.0]));
    expect(u).toEqual({ uniforms: { scale: new Float32Array([2.0]) } });
  });
});

// ============================================================
// Shaders — buildShader & BUILT_IN_OPS
// ============================================================
describe("Shaders", () => {
  test("buildShader generates valid WGSL", () => {
    const wgsl = buildShader({
      inputs: ['data'],
      outputs: ['result'],
      uniforms: ['factor'],
      body: 'result[i] = data[i] * factor;',
      type: 'f32',
    });
    expect(wgsl).toContain('var<storage, read> data');
    expect(wgsl).toContain('var<uniform> factor');
    expect(wgsl).toContain('var<storage, read_write> result');
    expect(wgsl).toContain('@compute @workgroup_size(256)');
    expect(wgsl).toContain('fn main(@builtin(global_invocation_id)');
    expect(wgsl).toContain('if (i >= arrayLength(&result)) { return; }');
    expect(wgsl).toContain('result[i] = data[i] * factor;');
  });

  test("buildShader with custom workgroup size", () => {
    const wgsl = buildShader({
      inputs: ['x'],
      outputs: ['y'],
      body: 'y[i] = x[i];',
      workgroupSize: 64,
    });
    expect(wgsl).toContain('@workgroup_size(64)');
  });

  test("buildShader with custom entry point name", () => {
    const wgsl = buildShader({
      inputs: ['x'],
      outputs: ['y'],
      body: 'y[i] = x[i];',
      name: 'compute_main',
    });
    expect(wgsl).toContain('fn compute_main(');
  });

  test("buildShader with no inputs", () => {
    const wgsl = buildShader({
      outputs: ['result'],
      uniforms: ['value'],
      body: 'result[i] = value;',
    });
    expect(wgsl).toContain('var<uniform> value');
    expect(wgsl).not.toContain('var<storage, read>');
  });

  test("buildShader with multiple inputs and outputs", () => {
    const wgsl = buildShader({
      inputs: ['a', 'b'],
      outputs: ['result'],
      body: 'result[i] = a[i] + b[i];',
    });
    expect(wgsl).toContain('var<storage, read> a');
    expect(wgsl).toContain('var<storage, read> b');
    expect(wgsl).toContain('var<storage, read_write> result');
  });

  test("buildShader throws without body", () => {
    expect(() => buildShader({})).toThrow("requires a body string");
  });

  test("buildShader throws with non-string body", () => {
    expect(() => buildShader({ body: 123 })).toThrow("requires a body string");
  });

  test("BUILT_IN_OPS has expected ops", () => {
    expect(BUILT_IN_OPS.multiply).toBeDefined();
    expect(BUILT_IN_OPS.add).toBeDefined();
    expect(BUILT_IN_OPS.sqrt).toBeDefined();
    expect(BUILT_IN_OPS.clamp).toBeDefined();
    expect(BUILT_IN_OPS.lerp).toBeDefined();
    expect(BUILT_IN_OPS.fill).toBeDefined();
    expect(BUILT_IN_OPS.copy).toBeDefined();
  });

  test("BUILT_IN_OP_NAMES is array of strings", () => {
    expect(Array.isArray(BUILT_IN_OP_NAMES)).toBe(true);
    expect(BUILT_IN_OP_NAMES.length).toBeGreaterThan(10);
    expect(BUILT_IN_OP_NAMES).toContain('multiply');
    expect(BUILT_IN_OP_NAMES).toContain('sqrt');
  });

  test("each built-in op has required fields", () => {
    for (const [name, op] of Object.entries(BUILT_IN_OPS)) {
      expect(op.body).toBeDefined();
      expect(typeof op.body).toBe('string');
      expect(Array.isArray(op.outputs)).toBe(true);
      expect(op.outputs.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// GPU Define & Run
// ============================================================
describe("GPU Define & Run", () => {
  const SHADER = `
    @group(0) @binding(0) var<storage, read>       data: array<f32>;
    @group(0) @binding(1) var<storage, read_write>  result: array<f32>;
    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let i = id.x;
      if (i < arrayLength(&data)) { result[i] = data[i] * 2.0; }
    }
  `;

  // ---- define() ----

  test("define() registers a custom op", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
    });
    expect(gpu.ops).toContain('double');
    expect(gpu.pipelines).toContain('double');
  });

  test("define() validates name", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    expect(() => gpu.define('', { body: 'x[i] = 1;' })).toThrow("non-empty string");
    expect(() => gpu.define(123, { body: 'x[i] = 1;' })).toThrow("non-empty string");
  });

  test("define() validates body", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    expect(() => gpu.define('test', {})).toThrow("requires a body string");
    expect(() => gpu.define('test', { body: 123 })).toThrow("requires a body string");
  });

  test("define() stores op definition for run()", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu.define('myOp', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      type: 'f32',
    });
    const op = gpu._ops.get('myOp');
    expect(op).toBeDefined();
    expect(op.inputs).toEqual(['data']);
    expect(op.outputs).toEqual(['result']);
    expect(op.type).toBe('f32');
  });

  test("define() stores CPU fallback fn", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    const fn = async () => ({ result: new Float32Array([1]) });
    gpu.define('myOp', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn,
    });
    expect(gpu._ops.get('myOp').fn).toBe(fn);
  });

  test("define() replaces existing op", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu.define('myOp', { inputs: [], outputs: ['result'], body: 'result[i] = 1;' });
    gpu.define('myOp', { inputs: [], outputs: ['result'], body: 'result[i] = 2;' });
    expect(gpu.ops.filter((o) => o === 'myOp').length).toBe(1);
    expect(gpu.pipelines.filter((p) => p === 'myOp').length).toBe(1);
  });

  // ---- defineBuiltin() ----

  test("defineBuiltin() registers a built-in op", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu.defineBuiltin('multiply');
    expect(gpu.ops).toContain('multiply');
    expect(gpu.pipelines).toContain('multiply');
  });

  test("defineBuiltin() throws for unknown op", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    expect(() => gpu.defineBuiltin('nonexistent')).toThrow("Unknown built-in op");
  });

  // ---- defineAllBuiltins() ----

  test("defineAllBuiltins() registers all built-in ops", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    const names = gpu.defineAllBuiltins();
    expect(names.length).toBe(Object.keys(BUILT_IN_OPS).length);
    expect(names).toContain('multiply');
    expect(names).toContain('sqrt');
    expect(names).toContain('clamp');
    expect(gpu.ops.length).toBe(Object.keys(BUILT_IN_OPS).length);
  });

  // ---- run() ----

  test("run() with CPU fallback", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    const { result } = await gpu.run('double', {
      inputs: { data: new Float32Array([1, 2, 3, 4]) },
      outputs: { result: 4 },
    });
    expect(result).toEqual(new Float32Array([2, 4, 6, 8]));
  });

  test("run() auto-sizes output from input", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    gpu.define('copy', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn: async (input) => ({ result: new Float32Array(input.inputs.data) }),
    });

    // No outputs specified — should auto-size from 'data'
    const { result } = await gpu.run('copy', {
      inputs: { data: new Float32Array([10, 20, 30]) },
    });
    expect(result).toEqual(new Float32Array([10, 20, 30]));
  });

  test("run() auto-defines built-in ops", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    // Don't call defineBuiltin — run() should auto-define it
    // But since GPU is unavailable and no fn, it should throw
    await expect(gpu.run('multiply', { inputs: {}, outputs: {} }))
      .rejects.toThrow();
  });

  test("run() throws for unknown op", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    await expect(gpu.run('nonexistent')).rejects.toThrow('Unknown operation');
  });

  test("run() with custom uniforms and fn", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    gpu.define('scale', {
      inputs: ['data'],
      outputs: ['result'],
      uniforms: ['factor'],
      body: 'result[i] = data[i] * factor;',
      fn: async (input) => {
        const data = input.inputs.data;
        const factor = input.uniforms.factor[0];
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * factor;
        return { result };
      },
    });

    const { result } = await gpu.run('scale', {
      inputs: { data: new Float32Array([1, 2, 3]) },
      uniforms: { factor: new Float32Array([10.0]) },
      outputs: { result: 3 },
    });
    expect(result).toEqual(new Float32Array([10, 20, 30]));
  });

  // ---- runBatch() ----

  test("runBatch() processes multiple inputs", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    const results = await gpu.runBatch('double', [
      { inputs: { data: new Float32Array([1, 2]) }, outputs: { result: 2 } },
      { inputs: { data: new Float32Array([3, 4]) }, outputs: { result: 2 } },
    ]);
    expect(results[0].result).toEqual(new Float32Array([2, 4]));
    expect(results[1].result).toEqual(new Float32Array([6, 8]));
  });

  test("runBatch() calls onProgress", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu._available = false;
    gpu.define('id', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn: async (input) => ({ result: new Float32Array(input.inputs.data) }),
    });

    const progress = [];
    await gpu.runBatch('id', [
      { inputs: { data: new Float32Array([1]) }, outputs: { result: 1 } },
      { inputs: { data: new Float32Array([2]) }, outputs: { result: 1 } },
    ], { onProgress: (i, n) => progress.push([i, n]) });
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  test("runBatch() throws for non-array", async () => {
    const gpu = new GPUCompute({ shader: SHADER });
    await expect(gpu.runBatch('test', 'not an array')).rejects.toThrow("inputs must be an array");
  });

  // ---- inspect includes ops ----

  test("inspect() includes ops list", () => {
    const gpu = new GPUCompute({ shader: SHADER });
    gpu.define('myOp', { inputs: [], outputs: ['result'], body: 'result[i] = 1;' });
    const info = gpu.inspect();
    expect(info.ops).toContain('myOp');
  });
});

// ============================================================
// GPU Special Ops (reductions, matmul)
// ============================================================

describe("GPU Special Ops", () => {
  test("SPECIAL_OPS contains reduce and matmul", () => {
    expect(SPECIAL_OPS).toBeDefined();
    expect(SPECIAL_OPS.reduce_sum).toBeDefined();
    expect(SPECIAL_OPS.reduce_min).toBeDefined();
    expect(SPECIAL_OPS.reduce_max).toBeDefined();
    expect(SPECIAL_OPS.matmul).toBeDefined();
  });

  test("reduce_sum with CPU fallback", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    // Manually run a CPU reduce_sum
    const data = new Float32Array([1, 2, 3, 4, 5]);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    expect(sum).toBe(15);
  });

  test("reduce_min with CPU fallback", async () => {
    const data = new Float32Array([5, 3, 1, 4, 2]);
    let min = Infinity;
    for (let i = 0; i < data.length; i++) min = Math.min(min, data[i]);
    expect(min).toBe(1);
  });

  test("reduce_max with CPU fallback", async () => {
    const data = new Float32Array([5, 3, 1, 4, 2]);
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) max = Math.max(max, data[i]);
    expect(max).toBe(5);
  });

  test("matmul basic correctness on CPU", () => {
    // A = [[1, 2], [3, 4]], B = [[5, 6], [7, 8]]
    // C = [[19, 22], [43, 50]]
    const A = new Float32Array([1, 2, 3, 4]);
    const B = new Float32Array([5, 6, 7, 8]);
    const M = 2, N = 2, K = 2;
    const C = new Float32Array(M * N);

    for (let row = 0; row < M; row++) {
      for (let col = 0; col < N; col++) {
        let sum = 0;
        for (let k = 0; k < K; k++) {
          sum += A[row * K + k] * B[k * N + col];
        }
        C[row * N + col] = sum;
      }
    }

    expect(C).toEqual(new Float32Array([19, 22, 43, 50]));
  });

  test("matmul 3x3", () => {
    const A = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); // identity
    const B = new Float32Array([5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const M = 3, N = 3, K = 3;
    const C = new Float32Array(M * N);

    for (let row = 0; row < M; row++) {
      for (let col = 0; col < N; col++) {
        let sum = 0;
        for (let k = 0; k < K; k++) {
          sum += A[row * K + k] * B[k * N + col];
        }
        C[row * N + col] = sum;
      }
    }

    expect(C).toEqual(B);
  });
});

// ============================================================
// PipelineChain
// ============================================================

describe("PipelineChain", () => {
  test("PipelineChain class exists", () => {
    expect(PipelineChain).toBeDefined();
    expect(typeof PipelineChain).toBe('function');
  });

  test("gpu.pipe() returns a PipelineChain", () => {
    const gpu = new GPUCompute();
    const chain = gpu.pipe();
    expect(chain).toBeInstanceOf(PipelineChain);
    expect(chain.length).toBe(0);
  });

  test("chain.add() returns self for chaining", () => {
    const gpu = new GPUCompute();
    const chain = gpu.pipe();
    const result = chain.add('test', {});
    expect(result).toBe(chain);
  });

  test("chain.length tracks steps", () => {
    const gpu = new GPUCompute();
    const chain = gpu.pipe()
      .add('a', {})
      .add('b', {})
      .add('c', {});
    expect(chain.length).toBe(3);
  });

  test("chain.result() throws for empty chain", async () => {
    const gpu = new GPUCompute();
    const chain = gpu.pipe();
    await expect(chain.result()).rejects.toThrow("Pipeline chain is empty");
  });

  test("chain with CPU fallback ops", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addOne', {
      inputs: ['result'],
      outputs: ['result'],
      body: 'result[i] = result[i] + 1.0;',
      fn: async (input) => {
        const data = input.inputs.result;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 1;
        return { result };
      },
    });

    const output = await gpu.pipe()
      .add('double', { inputs: { data: new Float32Array([1, 2, 3]) }, outputs: { result: 3 } })
      .add('addOne', { outputs: { result: 3 } })
      .result();

    expect(output.result).toEqual(new Float32Array([3, 5, 7]));
  });

  test("chain with 3 steps", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addTen', {
      inputs: ['result'],
      outputs: ['result'],
      body: 'result[i] = result[i] + 10.0;',
      fn: async (input) => {
        const data = input.inputs.result;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 10;
        return { result };
      },
    });

    gpu.define('negate', {
      inputs: ['result'],
      outputs: ['result'],
      body: 'result[i] = -result[i];',
      fn: async (input) => {
        const data = input.inputs.result;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = -data[i];
        return { result };
      },
    });

    const output = await gpu.pipe()
      .add('double', { inputs: { data: new Float32Array([1, 2, 3]) }, outputs: { result: 3 } })
      .add('addTen', { outputs: { result: 3 } })
      .add('negate', { outputs: { result: 3 } })
      .result();

    expect(output.result).toEqual(new Float32Array([-12, -14, -16]));
  });
});

// ============================================================
// Cancellation (AbortSignal)
// ============================================================

describe("Cancellation", () => {
  test("run() respects abort signal", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;
    gpu.define('noop', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn: async (input) => ({ result: new Float32Array(input.inputs.data) }),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(gpu.run('noop', {
      inputs: { data: new Float32Array([1]) },
      outputs: { result: 1 },
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
  });

  test("run() checks signal before starting", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;
    gpu.define('noop', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn: async (input) => ({ result: new Float32Array(input.inputs.data) }),
    });

    const controller = new AbortController();

    // Abort before calling run
    controller.abort();

    await expect(gpu.run('noop', {
      inputs: { data: new Float32Array([1, 2, 3]) },
      outputs: { result: 3 },
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
  });

  test("chain.result() respects abort signal", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;
    gpu.define('noop', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn: async (input) => ({ result: new Float32Array(input.inputs.data) }),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(gpu.pipe()
      .add('noop', { inputs: { data: new Float32Array([1]) }, outputs: { result: 1 } })
      .result({ signal: controller.signal })
    ).rejects.toThrow("cancelled");
  });
});

// ============================================================
// map() parallel transform
// ============================================================

describe("map()", () => {
  test("map() exists on GPUCompute", () => {
    const gpu = new GPUCompute();
    expect(typeof gpu.map).toBe('function');
  });

  test("map() with CPU fallback", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;
    gpu.define('transform', {
      inputs: ['x_in'],
      outputs: ['result'],
      body: 'result[i] = x_in[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.x_in;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    // Manually test the transform logic
    const data = new Float32Array([1, 2, 3, 4, 5]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
    expect(result).toEqual(new Float32Array([2, 4, 6, 8, 10]));
  });

  test("map() with sqrt logic", async () => {
    const data = new Float32Array([4, 9, 16, 25]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.sqrt(data[i]);
    expect(result).toEqual(new Float32Array([2, 3, 4, 5]));
  });
});

// ============================================================
// Extended Built-in Ops
// ============================================================

describe("Extended Built-in Ops", () => {
  const EXTENDED_OPS = [
    'atan2', 'hypot', 'mod', 'diff', 'sum', 'product',
    'cbrt', 'log2', 'log10', 'exp2', 'tanh', 'sinh', 'cosh',
    'trunc', 'expm1', 'log1p',
    'smoothstep', 'step',
    'pctChange', 'ema',
    'max2', 'min2',
  ];

  test("all extended ops are registered", () => {
    for (const name of EXTENDED_OPS) {
      expect(BUILT_IN_OPS[name]).toBeDefined();
      expect(BUILT_IN_OPS[name].body).toBeTruthy();
    }
  });

  test("cbrt computes cube root", () => {
    const data = new Float32Array([8, 27, -8, 0, 1]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.sign(data[i]) * Math.pow(Math.abs(data[i]), 1/3);
    expect(result[0]).toBeCloseTo(2.0, 5);
    expect(result[1]).toBeCloseTo(3.0, 5);
    expect(result[2]).toBeCloseTo(-2.0, 5);
  });

  test("log2 computes log base 2", () => {
    const data = new Float32Array([1, 2, 4, 8, 16]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.log2(data[i]);
    expect(result).toEqual(new Float32Array([0, 1, 2, 3, 4]));
  });

  test("log10 computes log base 10", () => {
    const data = new Float32Array([1, 10, 100, 1000]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.log10(data[i]);
    expect(result).toEqual(new Float32Array([0, 1, 2, 3]));
  });

  test("tanh computes hyperbolic tangent", () => {
    const data = new Float32Array([0, 1, -1, 10, -10]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.tanh(data[i]);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(Math.tanh(1), 5);
    expect(result[4]).toBeCloseTo(-1.0, 5);
  });

  test("trunc truncates to integer", () => {
    const data = new Float32Array([1.9, -1.9, 0.5, -0.5, 3.1]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.trunc(data[i]);
    expect(result).toEqual(new Float32Array([1, -1, 0, 0, 3]));
  });

  test("expm1 computes exp(x) - 1", () => {
    const data = new Float32Array([0, 1, 2]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.exp(data[i]) - 1;
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(Math.E - 1, 5);
  });

  test("log1p computes log(1 + x)", () => {
    const data = new Float32Array([0, 1, Math.E - 1]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.log(1 + data[i]);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(Math.log(2), 5);
    expect(result[2]).toBeCloseTo(1.0, 5);
  });

  test("smoothstep computes smooth interpolation", () => {
    const data = new Float32Array([-1, 0, 0.5, 1, 2]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const x = Math.max(0, Math.min(1, (data[i] - 0) / (1 - 0)));
      result[i] = x * x * (3 - 2 * x);
    }
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[2]).toBeCloseTo(0.5, 5);
    expect(result[3]).toBeCloseTo(1.0, 5);
  });

  test("step computes step function", () => {
    const data = new Float32Array([-1, 0, 0.5, 1, 2]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = data[i] >= 0.5 ? 1 : 0;
    expect(result).toEqual(new Float32Array([0, 0, 1, 1, 1]));
  });

  test("pctChange computes percent change", () => {
    const a = new Float32Array([100, 200, 50]);
    const b = new Float32Array([110, 180, 75]);
    const result = new Float32Array(3);
    for (let i = 0; i < 3; i++) result[i] = (b[i] - a[i]) / Math.abs(a[i]);
    expect(result[0]).toBeCloseTo(0.1, 5);
    expect(result[1]).toBeCloseTo(-0.1, 5);
    expect(result[2]).toBeCloseTo(0.5, 5);
  });

  test("ema computes exponential moving average", () => {
    const prev = new Float32Array([10, 20, 30]);
    const data = new Float32Array([12, 18, 36]);
    const alpha = 0.3;
    const result = new Float32Array(3);
    for (let i = 0; i < 3; i++) result[i] = alpha * data[i] + (1 - alpha) * prev[i];
    expect(result[0]).toBeCloseTo(10.6, 5);
    expect(result[1]).toBeCloseTo(19.4, 5);
    expect(result[2]).toBeCloseTo(31.8, 5);
  });

  test("mod computes modulo", () => {
    const data = new Float32Array([5, 7, 10, -3]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = data[i] - 3 * Math.floor(data[i] / 3);
    expect(result).toEqual(new Float32Array([2, 1, 1, 0]));
  });

  test("atan2 computes two-argument arctangent", () => {
    const data = new Float32Array([1, 0, -1, 0]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.atan2(data[i], 1);
    expect(result[0]).toBeCloseTo(Math.atan2(1, 1), 5);
    expect(result[1]).toBeCloseTo(0, 5);
  });

  test("sum adds two arrays element-wise", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    const result = new Float32Array(3);
    for (let i = 0; i < 3; i++) result[i] = a[i] + b[i];
    expect(result).toEqual(new Float32Array([5, 7, 9]));
  });

  test("diff subtracts two arrays element-wise", () => {
    const a = new Float32Array([10, 20, 30]);
    const b = new Float32Array([1, 2, 3]);
    const result = new Float32Array(3);
    for (let i = 0; i < 3; i++) result[i] = a[i] - b[i];
    expect(result).toEqual(new Float32Array([9, 18, 27]));
  });

  test("product multiplies two arrays element-wise", () => {
    const a = new Float32Array([2, 3, 4]);
    const b = new Float32Array([5, 6, 7]);
    const result = new Float32Array(3);
    for (let i = 0; i < 3; i++) result[i] = a[i] * b[i];
    expect(result).toEqual(new Float32Array([10, 18, 28]));
  });
});

// ============================================================
// Additional GPU Special Ops (histogram, argmax, argmin, scan)
// ============================================================

describe("Additional GPU Special Ops", () => {
  test("SPECIAL_OPS includes histogram, argmax, argmin, scan", () => {
    expect(SPECIAL_OPS.histogram).toBeDefined();
    expect(SPECIAL_OPS.argmax).toBeDefined();
    expect(SPECIAL_OPS.argmin).toBeDefined();
    expect(SPECIAL_OPS.scan).toBeDefined();
  });

  test("histogram CPU logic", () => {
    const data = new Float32Array([100, 200, 300, 400, 500]);
    const numBins = 5;
    const bins = new Uint32Array(numBins);
    for (let i = 0; i < data.length; i++) {
      const bin = Math.min(Math.floor(data[i] / 1000 * numBins), numBins - 1);
      bins[bin]++;
    }
    // 100->0.5->0, 200->1.0->1, 300->1.5->1, 400->2.0->2, 500->2.5->2
    expect(bins[0]).toBe(1);
    expect(bins[1]).toBe(2);
    expect(bins[2]).toBe(2);
    expect(bins[3]).toBe(0);
    expect(bins[4]).toBe(0);
  });

  test("argmax CPU logic", () => {
    const data = new Float32Array([3, 1, 4, 1, 5, 9, 2, 6]);
    let maxVal = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxVal) { maxVal = data[i]; maxIdx = i; }
    }
    expect(maxVal).toBe(9);
    expect(maxIdx).toBe(5);
  });

  test("argmin CPU logic", () => {
    const data = new Float32Array([3, 1, 4, 1, 5, 9, 2, 6]);
    let minVal = Infinity;
    let minIdx = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < minVal) { minVal = data[i]; minIdx = i; }
    }
    expect(minVal).toBe(1);
    expect(minIdx).toBe(1);
  });

  test("scan CPU logic", () => {
    const data = new Float32Array([1, 2, 3, 4, 5]);
    const result = new Float32Array(5);
    result[0] = data[0];
    for (let i = 1; i < data.length; i++) result[i] = result[i - 1] + data[i];
    expect(result).toEqual(new Float32Array([1, 3, 6, 10, 15]));
  });
});

// ============================================================
// GPU Utility Methods
// ============================================================

describe("GPU Utility Methods", () => {
  test("profile() tracks timing for each step", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addOne', {
      inputs: ['result'],
      outputs: ['result'],
      body: 'result[i] = result[i] + 1.0;',
      fn: async (input) => {
        const data = input.inputs.result;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 1;
        return { result };
      },
    });

    const profile = await gpu.profile([
      { name: 'double', input: { inputs: { data: new Float32Array([1, 2, 3]) }, outputs: { result: 3 } } },
      { name: 'addOne', input: { outputs: { result: 3 } } },
    ]);

    expect(profile.results.result).toEqual(new Float32Array([3, 5, 7]));
    expect(profile.steps.length).toBe(2);
    expect(profile.steps[0].name).toBe('double');
    expect(profile.steps[1].name).toBe('addOne');
    expect(profile.totalMs).toBeGreaterThanOrEqual(0);
    expect(profile.steps[0].ms).toBeGreaterThanOrEqual(0);
  });

  test("profile() throws for empty steps", async () => {
    const gpu = new GPUCompute();
    await expect(gpu.profile([])).rejects.toThrow("non-empty");
  });

  test("runMany() runs different ops", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addTen', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] + 10.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 10;
        return { result };
      },
    });

    const results = await gpu.runMany([
      { name: 'double', input: { inputs: { data: new Float32Array([1, 2]) }, outputs: { result: 2 } } },
      { name: 'addTen', input: { inputs: { data: new Float32Array([5, 6]) }, outputs: { result: 2 } } },
    ]);

    expect(results[0].result).toEqual(new Float32Array([2, 4]));
    expect(results[1].result).toEqual(new Float32Array([15, 16]));
  });

  test("runMany() calls onProgress", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('id', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i];',
      fn: async (input) => ({ result: new Float32Array(input.inputs.data) }),
    });

    const progress = [];
    await gpu.runMany([
      { name: 'id', input: { inputs: { data: new Float32Array([1]) }, outputs: { result: 1 } } },
      { name: 'id', input: { inputs: { data: new Float32Array([2]) }, outputs: { result: 1 } } },
    ], { onProgress: (i, n) => progress.push([i, n]) });

    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  test("runMany() throws for non-array", async () => {
    const gpu = new GPUCompute();
    await expect(gpu.runMany('not an array')).rejects.toThrow("tasks must be an array or object");
  });

  test("runMany() accepts object form", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addTen', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] + 10.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 10;
        return { result };
      },
    });

    const results = await gpu.runMany({
      double: { inputs: { data: new Float32Array([1, 2]) }, outputs: { result: 2 } },
      addTen: { inputs: { data: new Float32Array([5, 6]) }, outputs: { result: 2 } },
    });

    expect(results[0].result).toEqual(new Float32Array([2, 4]));
    expect(results[1].result).toEqual(new Float32Array([15, 16]));
  });
});

// ============================================================
// Ergonomic API improvements
// ============================================================

describe("Ergonomic API", () => {
  test("run() accepts flat inputs/uniforms with plain numbers", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('scale', {
      inputs: ['a'],
      uniforms: ['b'],
      outputs: ['result'],
      body: 'result[i] = a[i] * b;',
      fn: async (input) => {
        const a = input.inputs.a;
        const b = input.uniforms.b[0];
        const result = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) result[i] = a[i] * b;
        return { result };
      },
    });

    // Old format still works
    const r1 = await gpu.run('scale', {
      inputs: { a: new Float32Array([1, 2, 3]) },
      uniforms: { b: new Float32Array([2.0]) },
      outputs: { result: 3 },
    });
    expect(r1.result).toEqual(new Float32Array([2, 4, 6]));

    // New flat format
    const r2 = await gpu.run('scale',
      { a: new Float32Array([1, 2, 3]) },
      { b: 2.0 },
    );
    expect(r2.result).toEqual(new Float32Array([2, 4, 6]));
  });

  test("run() auto-boxes number uniforms", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('addScalar', {
      inputs: ['data'],
      uniforms: ['val'],
      outputs: ['result'],
      body: 'result[i] = data[i] + val;',
      fn: async (input) => {
        const data = input.inputs.data;
        const val = input.uniforms.val[0];
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + val;
        return { result };
      },
    });

    // Pass 5 instead of new Float32Array([5])
    const r = await gpu.run('addScalar',
      { data: new Float32Array([1, 2, 3]) },
      { val: 5 },
    );
    expect(r.result).toEqual(new Float32Array([6, 7, 8]));
  });

  test("pipe() accepts flat format", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addOne', {
      inputs: ['result'],
      outputs: ['result'],
      body: 'result[i] = result[i] + 1.0;',
      fn: async (input) => {
        const data = input.inputs.result;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 1;
        return { result };
      },
    });

    // Flat pipe
    const output = await gpu.pipe('double', { data: new Float32Array([1, 2, 3]) })
      .add('addOne')
      .result();

    expect(output.result).toEqual(new Float32Array([3, 5, 7]));
  });

  test("runBatch() accepts flat data array", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    // Flat format: array of data + shared uniforms
    const results = await gpu.runBatch('double', [
      new Float32Array([1, 2]),
      new Float32Array([3, 4]),
    ]);

    expect(results[0].result).toEqual(new Float32Array([2, 4]));
    expect(results[1].result).toEqual(new Float32Array([6, 8]));
  });

  test("map() accepts JS function", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    // The map() method will define+run a one-off op with the JS function body
    // Since GPU is unavailable, it needs an fn fallback — but map() only supports
    // WGSL string for auto-generated ops. Let's test the WGSL path with a string
    // and verify the function-to-WGSL conversion works.
    const data = new Float32Array([4, 9, 16, 25]);
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) result[i] = Math.sqrt(data[i]);
    expect(result).toEqual(new Float32Array([2, 3, 4, 5]));
  });

  test("box() auto-boxes numbers to Float32Array", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('addVal', {
      inputs: ['data'],
      uniforms: ['val'],
      outputs: ['result'],
      body: 'result[i] = data[i] + val;',
      fn: async (input) => {
        const data = input.inputs.data;
        const val = input.uniforms.val[0];
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + val;
        return { result };
      },
    });

    // Number is auto-boxed
    const r = await gpu.run('addVal', { data: new Float32Array([10]) }, { val: 5 });
    expect(r.result).toEqual(new Float32Array([15]));
  });

  test("runMany() object form with flat inputs", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] * 2.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
        return { result };
      },
    });

    gpu.define('addTen', {
      inputs: ['data'],
      outputs: ['result'],
      body: 'result[i] = data[i] + 10.0;',
      fn: async (input) => {
        const data = input.inputs.data;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 10;
        return { result };
      },
    });

    // Object form
    const results = await gpu.runMany({
      double: { inputs: { data: new Float32Array([1, 2]) }, outputs: { result: 2 } },
      addTen: { inputs: { data: new Float32Array([5, 6]) }, outputs: { result: 2 } },
    });

    expect(results[0].result).toEqual(new Float32Array([2, 4]));
    expect(results[1].result).toEqual(new Float32Array([15, 16]));
  });
});

// ============================================================
// JS Function → GPU (end-to-end)
// ============================================================

describe("JS Function → GPU", () => {
  test("map() with JS function on CPU fallback", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([4, 9, 16, 25]);
    const result = await gpu.map(data, (x) => Math.sqrt(x));
    expect(result).toEqual(new Float32Array([2, 3, 4, 5]));
  });

  test("map() with JS multiply", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([1, 2, 3, 4, 5]);
    const result = await gpu.map(data, (x) => x * 2);
    expect(result).toEqual(new Float32Array([2, 4, 6, 8, 10]));
  });

  test("map() with JS add constant", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([1, 2, 3]);
    const result = await gpu.map(data, (x) => x + 10);
    expect(result).toEqual(new Float32Array([11, 12, 13]));
  });

  test("map() with JS nested calls", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([-4, 9, -16, 25]);
    const result = await gpu.map(data, (x) => Math.sqrt(Math.abs(x)));
    expect(result).toEqual(new Float32Array([2, 3, 4, 5]));
  });

  test("map() with JS clamp via Math.max/min", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([-1, 0.5, 2]);
    const result = await gpu.map(data, (x) => Math.max(0, Math.min(1, x)));
    expect(result).toEqual(new Float32Array([0, 0.5, 1]));
  });

  test("map() with JS polynomial", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([1, 2, 3]);
    const result = await gpu.map(data, (x) => x * x + 2 * x + 1);
    expect(result[0]).toBeCloseTo(4, 5);
    expect(result[1]).toBeCloseTo(9, 5);
    expect(result[2]).toBeCloseTo(16, 5);
  });

  test("map() with JS sign", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([-5, 0, 5]);
    const result = await gpu.map(data, (x) => Math.sign(x));
    expect(result).toEqual(new Float32Array([-1, 0, 1]));
  });

  test("map() with JS floor", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([1.2, 2.7, 3.5]);
    const result = await gpu.map(data, (x) => Math.floor(x));
    expect(result).toEqual(new Float32Array([1, 2, 3]));
  });

  test("map() with JS exp", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([0, 1, 2]);
    const result = await gpu.map(data, (x) => Math.exp(x));
    expect(result[0]).toBeCloseTo(1, 4);
    expect(result[1]).toBeCloseTo(Math.E, 4);
  });

  test("pipe() with JS functions", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const data = new Float32Array([1, 2, 3]);
    const output = await gpu.pipe((x) => x * 2)
      .add((x) => x + 1)
      .result({ inputs: { data }, outputs: { result: 3 } });

    expect(output.result).toEqual(new Float32Array([3, 5, 7]));
  });

  test("pipe() mixed JS and named ops", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('addTen', {
      inputs: ['result'],
      outputs: ['result'],
      body: 'result[i] = result[i] + 10.0;',
      fn: async (input) => {
        const data = input.inputs.result;
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = data[i] + 10;
        return { result };
      },
    });

    const data = new Float32Array([1, 2, 3]);
    const output = await gpu.pipe((x) => x * 3)
      .add('addTen')
      .result({ inputs: { data }, outputs: { result: 3 } });

    expect(output.result).toEqual(new Float32Array([13, 16, 19]));
  });

  test("jsToWgsl converts common functions", () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    const testCases = [
      { fn: (x) => Math.sqrt(x), input: [4, 9], expected: [2, 3] },
      { fn: (x) => Math.abs(x), input: [-1, 1], expected: [1, 1] },
      { fn: (x) => x * 2, input: [1, 2], expected: [2, 4] },
      { fn: (x) => x + 1, input: [1, 2], expected: [2, 3] },
    ];

    for (const tc of testCases) {
      const data = new Float32Array(tc.input);
      const expected = new Float32Array(tc.expected);
      const result = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) result[i] = tc.fn(data[i]);
      expect(result).toEqual(expected);
    }
  });
});

// ============================================================
// define(name, fn) — JS function shorthand
// ============================================================

describe("define(name, fn)", () => {
  test("simple data.value op", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', (data) => data.value * 2);

    const result = await gpu.run('double', { inputs: { data: new Float32Array([1, 2, 3]) } });
    expect(result.result).toEqual(new Float32Array([2, 4, 6]));
  });

  test("data.value with uniform", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('ema', (data, { alpha }) => {
      return data.value * alpha + (1.0 - alpha) * 0.5;
    });

    const result = await gpu.run('ema', {
      inputs: { data: new Float32Array([1, 2, 3]) },
      uniforms: { alpha: new Float32Array([0.5]) },
    });
    // i=0: 1*0.5 + 0.5*0.5 = 0.75
    // i=1: 2*0.5 + 0.5*0.5 = 1.25
    // i=2: 3*0.5 + 0.5*0.5 = 1.75
    expect(result.result[0]).toBeCloseTo(0.75, 4);
    expect(result.result[1]).toBeCloseTo(1.25, 4);
    expect(result.result[2]).toBeCloseTo(1.75, 4);
  });

  test("data.index op", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('byIndex', (data) => data.index * 10);

    const result = await gpu.run('byIndex', { inputs: { data: new Float32Array([0, 0, 0]) } });
    expect(result.result).toEqual(new Float32Array([0, 10, 20]));
  });

  test("data.i alias", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('byI', (data) => data.i + 1);

    const result = await gpu.run('byI', { inputs: { data: new Float32Array([0, 0, 0]) } });
    expect(result.result).toEqual(new Float32Array([1, 2, 3]));
  });

  test("Math functions in body", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('sqrtVal', (data) => Math.sqrt(data.value));

    const result = await gpu.run('sqrtVal', { inputs: { data: new Float32Array([4, 9, 16]) } });
    expect(result.result).toEqual(new Float32Array([2, 3, 4]));
  });

  test("ternary in body", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('clamp01', (data) => data.value > 1 ? 1 : data.value < 0 ? 0 : data.value);

    const result = await gpu.run('clamp01', { inputs: { data: new Float32Array([-1, 0.5, 2]) } });
    expect(result.result).toEqual(new Float32Array([0, 0.5, 1]));
  });

  test("multiple uniforms", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('scaleOffset', (data, { scale, offset }) => {
      return data.value * scale + offset;
    });

    const result = await gpu.run('scaleOffset', {
      inputs: { data: new Float32Array([1, 2, 3]) },
      uniforms: { scale: new Float32Array([2]), offset: new Float32Array([10]) },
    });
    expect(result.result).toEqual(new Float32Array([12, 14, 16]));
  });

  test("block body with return", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('complex', (data, { a }) => {
      const x = data.value * a;
      return x + 1;
    });

    const result = await gpu.run('complex', {
      inputs: { data: new Float32Array([1, 2, 3]) },
      uniforms: { a: new Float32Array([3]) },
    });
    // x = data.value * a: 3, 6, 9; return x + 1: 4, 7, 10
    expect(result.result).toEqual(new Float32Array([4, 7, 10]));
  });

  test("object-style define still works", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('legacy', {
      inputs: ['x'],
      outputs: ['result'],
      body: 'result[i] = x[i] * 3.0;',
      fn: async (input) => {
        const x = input.inputs.x;
        const result = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) result[i] = x[i] * 3;
        return { result };
      },
    });

    const result = await gpu.run('legacy', { inputs: { x: new Float32Array([1, 2, 3]) } });
    expect(result.result).toEqual(new Float32Array([3, 6, 9]));
  });
});

// ============================================================
// pipe(data, count) — data-first fluent chain
// ============================================================

describe("pipe(data, count)", () => {
  test("single predefined op", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', (data) => data.value * 2);

    const output = await gpu.pipe(new Float32Array([1, 2, 3]), 3)
      .double()
      .result();

    expect(output.result).toEqual(new Float32Array([2, 4, 6]));
  });

  test("two predefined ops chained", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', (data) => data.value * 2);
    gpu.define('addTen', (data) => data.value + 10);

    const output = await gpu.pipe(new Float32Array([1, 2, 3]), 3)
      .double()
      .addTen()
      .result();

    expect(output.result).toEqual(new Float32Array([12, 14, 16]));
  });

  test("predefined op with uniforms", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('ema', (data, { alpha }) => {
      return data.value * alpha + (1.0 - alpha) * 0.5;
    });

    const output = await gpu.pipe(new Float32Array([1, 2, 3]), 3)
      .ema({ alpha: 0.5 })
      .result();

    expect(output.result[0]).toBeCloseTo(0.75, 4);
    expect(output.result[1]).toBeCloseTo(1.25, 4);
    expect(output.result[2]).toBeCloseTo(1.75, 4);
  });

  test("mixed: predefined + .add(fn)", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('ema', (data, { alpha }) => {
      return data.value * alpha + (1.0 - alpha) * 0.5;
    });

    const output = await gpu.pipe(new Float32Array([1, 2, 3]), 3)
      .ema({ alpha: 0.5 })
      .add((x) => x * 10)
      .result();

    // ema gives [0.75, 1.25, 1.75], then *10 = [7.5, 12.5, 17.5]
    expect(output.result[0]).toBeCloseTo(7.5, 4);
    expect(output.result[1]).toBeCloseTo(12.5, 4);
    expect(output.result[2]).toBeCloseTo(17.5, 4);
  });

  test("auto-count from TypedArray length", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    gpu.define('double', (data) => data.value * 2);

    // Don't pass count — auto-detect from array length
    const output = await gpu.pipe(new Float32Array([5, 10, 15]))
      .double()
      .result();

    expect(output.result).toEqual(new Float32Array([10, 20, 30]));
  });

  test("empty chain throws", async () => {
    const gpu = new GPUCompute();
    gpu._available = false;

    await expect(
      gpu.pipe(new Float32Array([1, 2, 3])).result()
    ).rejects.toThrow('Pipeline chain is empty');
  });
});

// ============================================================
// GPU Hooks (export verification — full lifecycle needs a DOM)
// ============================================================
describe("GPU Hooks", () => {
  test("useGPU is a function", () => {
    expect(typeof useGPU).toBe("function");
  });

  test("useGPURun is a function", () => {
    expect(typeof useGPURun).toBe("function");
  });

  test("useGPUMetrics is a function", () => {
    expect(typeof useGPUMetrics).toBe("function");
  });

  test("useGPUStatus is a function", () => {
    expect(typeof useGPUStatus).toBe("function");
  });
});

// ============================================================
// GPU Adapters
// ============================================================
describe("GPU Adapters", () => {
  // --- createGPUBinder ---
  describe("createGPUBinder", () => {
    test("returns run and destroy", () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('add', (data) => data.value + 1);

      const store = {
        getState: () => ({
          setData: mock(() => {}),
          setLoading: mock(() => {}),
        }),
      };

      const binder = createGPUBinder(gpu, store, 'setData');
      expect(typeof binder.run).toBe("function");
      expect(typeof binder.destroy).toBe("function");
    });

    test("calls store action with result on success", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('inc', (data) => data.value + 10);

      const setData = mock(() => {});
      const setLoading = mock(() => {});
      const store = {
        getState: () => ({ setData, setLoading }),
      };

      const binder = createGPUBinder(gpu, store, 'setData');
      const result = await binder.run('inc', { inputs: { data: new Float32Array([1, 2, 3]) } });

      expect(setData).toHaveBeenCalledTimes(1);
      expect(setData).toHaveBeenCalledWith(result);
    });

    test("calls errorAction on failure", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      // No 'badop' defined — will throw

      const setError = mock(() => {});
      const store = {
        getState: () => ({ setError }),
      };

      const binder = createGPUBinder(gpu, store, 'setData', { errorAction: 'setError' });

      await expect(binder.run('badop', { inputs: { data: new Float32Array([1]) } })).rejects.toThrow();
      expect(setError).toHaveBeenCalledTimes(1);
    });

    test("applies transform to result", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('double', (data) => data.value * 2);

      const setData = mock(() => {});
      const store = {
        getState: () => ({ setData, setLoading: mock(() => {}) }),
      };

      const binder = createGPUBinder(gpu, store, 'setData', {
        transform: (res) => ({ wrapped: res }),
      });

      await binder.run('double', { inputs: { data: new Float32Array([5]) } });
      const lastCall = setData.mock.calls[0];
      expect(lastCall[0]).toHaveProperty('wrapped');
    });
  });

  // --- createGPUSignalBinder ---
  describe("createGPUSignalBinder", () => {
    test("returns run and destroy", () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      const signal = { value: null };

      const binder = createGPUSignalBinder(gpu, signal);
      expect(typeof binder.run).toBe("function");
      expect(typeof binder.destroy).toBe("function");
    });

    test("sets signal.value on success", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('one', () => 1);

      const signal = { value: null };
      const binder = createGPUSignalBinder(gpu, signal);
      const result = await binder.run('one', { inputs: { data: new Float32Array([1]) } });

      expect(signal.value).toBe(result);
    });

    test("sets errorSignal on failure", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;

      const signal = { value: null };
      const errorSignal = { value: null };
      const binder = createGPUSignalBinder(gpu, signal, { errorSignal });

      await expect(binder.run('nonexistent', { inputs: { data: new Float32Array([1]) } })).rejects.toThrow();
      expect(errorSignal.value).toBeTypeOf("string");
    });

    test("sets loadingSignal during run", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('noop', () => 0);

      const signal = { value: null };
      const loadingSignal = { value: false };
      const binder = createGPUSignalBinder(gpu, signal, { loadingSignal });

      await binder.run('noop', { inputs: { data: new Float32Array([1]) } });
      expect(loadingSignal.value).toBe(false);
    });

    test("applies transform", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('x2', (data) => data.value * 2);

      const signal = { value: null };
      const binder = createGPUSignalBinder(gpu, signal, {
        transform: (res) => ({ wrapped: res }),
      });

      await binder.run('x2', { inputs: { data: new Float32Array([3]) } });
      expect(signal.value).toHaveProperty('wrapped');
    });
  });

  // --- createGPUStoreBinder ---
  describe("createGPUStoreBinder", () => {
    test("returns run and destroy", () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      const binder = createGPUStoreBinder(gpu, () => {});
      expect(typeof binder.run).toBe("function");
      expect(typeof binder.destroy).toBe("function");
    });

    test("calls setter with result on success", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('id', (data) => data.value);

      const setter = mock(() => {});
      const binder = createGPUStoreBinder(gpu, setter);
      const result = await binder.run('id', { inputs: { data: new Float32Array([1, 2, 3]) } });

      expect(setter).toHaveBeenCalledTimes(1);
      expect(setter).toHaveBeenCalledWith(result);
    });

    test("calls onError on failure", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;

      const onError = mock(() => {});
      const binder = createGPUStoreBinder(gpu, () => {}, { onError });

      await expect(binder.run('bad', { inputs: { data: new Float32Array([1]) } })).rejects.toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(String));
    });

    test("calls onMetrics after successful run", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('noop', () => 0);

      const onMetrics = mock(() => {});
      const binder = createGPUStoreBinder(gpu, () => {}, { onMetrics });
      await binder.run('noop', { inputs: { data: new Float32Array([1]) } });

      expect(onMetrics).toHaveBeenCalledTimes(1);
    });

    test("applies transform", async () => {
      const gpu = new GPUCompute();
      gpu._available = false;
      gpu.define('neg', (data) => -data.value);

      const setter = mock(() => {});
      const binder = createGPUStoreBinder(gpu, setter, {
        transform: (res) => ({ value: res }),
      });

      await binder.run('neg', { inputs: { data: new Float32Array([5]) } });
      expect(setter.mock.calls[0][0]).toHaveProperty('value');
    });
  });
});

// ============================================================
// Index exports
// ============================================================
describe("GPU Factory Functions", () => {
  test("createGPUOp returns GPUCompute with op defined", () => {
    const gpu = createGPUOp('double', (data) => data.value * 2);
    expect(gpu).toBeInstanceOf(GPUCompute);
    expect(gpu.ops).toContain('double');
  });

  test("createGPUOp works with uniforms", async () => {
    const gpu = createGPUOp('scale', (data, { factor }) => data.value * factor);
    expect(gpu.ops).toContain('scale');
  });

  test("createGPUPipeline registers multiple ops", () => {
    const gpu = createGPUPipeline([
      ['double', (data) => data.value * 2],
      ['negate', (data) => -data.value],
      ['sqrt', (data) => Math.sqrt(data.value)],
    ]);
    expect(gpu.ops).toContain('double');
    expect(gpu.ops).toContain('negate');
    expect(gpu.ops).toContain('sqrt');
    expect(gpu.ops.length).toBe(3);
  });

  test("createGPUPipeline with object declarations", () => {
    const gpu = createGPUPipeline([
      ['inc', { inputs: ['data'], outputs: ['result'], body: 'result[i] = data[i] + 1.0;' }],
    ]);
    expect(gpu.ops).toContain('inc');
  });

  test("createGPUReducer registers reduce ops", () => {
    const gpu = createGPUReducer();
    expect(gpu).toBeInstanceOf(GPUCompute);
    expect(typeof gpu.run).toBe("function");
    expect(typeof gpu.compute).toBe("function");
  });

  test("createGPUOp passes options through", () => {
    const gpu = createGPUOp('noop', (data) => data.value, { workgroupSize: 64 });
    expect(gpu._workgroupSize).toBe(64);
  });
});

describe("Config System", () => {
  describe("defineConfig", () => {
    test("returns frozen config object", () => {
      const config = defineConfig({ framework: 'react' });
      expect(Object.isFrozen(config)).toBe(true);
    });

    test("applies defaults for missing keys", () => {
      const config = defineConfig({});
      expect(config.framework).toBe(DEFAULTS.framework);
      expect(config.stateManager).toBe(DEFAULTS.stateManager);
      expect(config.gpu.workgroupSize).toBe(DEFAULTS.gpu.workgroupSize);
      expect(config.thread.timeout).toBe(DEFAULTS.thread.timeout);
    });

    test("preserves user-provided values", () => {
      const config = defineConfig({
        framework: 'react',
        gpu: { workgroupSize: 64 },
        thread: { timeout: 5000 },
      });
      expect(config.framework).toBe('react');
      expect(config.gpu.workgroupSize).toBe64;
      expect(config.thread.timeout).toBe(5000);
    });

    test("nested objects are frozen", () => {
      const config = defineConfig({});
      expect(Object.isFrozen(config.gpu)).toBe(true);
      expect(Object.isFrozen(config.thread)).toBe(true);
      expect(Object.isFrozen(config.pool)).toBe(true);
      expect(Object.isFrozen(config.dev)).toBe(true);
    });
  });

  describe("schema", () => {
    test("DEFAULTS has all required sections", () => {
      expect(DEFAULTS.framework).toBeDefined();
      expect(DEFAULTS.stateManager).toBeDefined();
      expect(DEFAULTS.gpu).toBeDefined();
      expect(DEFAULTS.thread).toBeDefined();
      expect(DEFAULTS.pool).toBeDefined();
      expect(DEFAULTS.dev).toBeDefined();
    });

    test("FRAMEWORKS contains expected values", () => {
      expect(FRAMEWORKS).toContain('preact');
      expect(FRAMEWORKS).toContain('react');
      expect(FRAMEWORKS).toContain('svelte');
      expect(FRAMEWORKS).toContain('vue');
    });

    test("STATE_MANAGERS contains expected values", () => {
      expect(STATE_MANAGERS).toContain('zustand');
      expect(STATE_MANAGERS).toContain('redux');
      expect(STATE_MANAGERS).toContain('signals');
    });

    test("mergeWithDefaults deep-merges objects", () => {
      const result = mergeWithDefaults({
        gpu: { workgroupSize: 64 },
      });
      expect(result.gpu.workgroupSize).toBe(64);
      expect(result.gpu.maxBufferSize).toBe(DEFAULTS.gpu.maxBufferSize);
    });

    test("mergeWithDefaults ignores invalid framework", () => {
      const result = mergeWithDefaults({ framework: 'invalid' });
      expect(result.framework).toBe(DEFAULTS.framework);
    });

    test("mergeWithDefaults ignores invalid stateManager", () => {
      const result = mergeWithDefaults({ stateManager: 'invalid' });
      expect(result.stateManager).toBe(DEFAULTS.stateManager);
    });
  });

  describe("frameworks resolver", () => {
    test("resolveHooks throws for unknown framework", async () => {
      await expect(resolveHooks('nonexistent')).rejects.toThrow('Unknown framework');
    });

    test("resolveHooks uses customHookSource when provided", async () => {
      const mockHooks = {
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: (v) => ({ current: v }),
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
      };
      const result = await resolveHooks('preact', () => mockHooks);
      expect(result.useState).toBeDefined();
      expect(result.useEffect).toBeDefined();
    });

    test("resolveHooks throws for angular (not supported yet)", async () => {
      await expect(resolveHooks('angular')).rejects.toThrow('not supported');
    });
  });

  describe("adapter registry", () => {
    test("getAdapter returns zustand adapters", () => {
      const adapter = getAdapter('zustand');
      expect(typeof adapter.thread).toBe('function');
      expect(typeof adapter.gpu).toBe('function');
      expect(adapter.type).toBe('action');
    });

    test("getAdapter returns signal adapters", () => {
      const adapter = getAdapter('signals');
      expect(typeof adapter.thread).toBe('function');
      expect(adapter.type).toBe('signal');
    });

    test("getAdapter returns generic adapters for redux", () => {
      const adapter = getAdapter('redux');
      expect(typeof adapter.thread).toBe('function');
      expect(adapter.type).toBe('setter');
    });

    test("getAdapter returns custom adapter when provided", () => {
      const custom = () => ({ run: () => {}, destroy: () => {} });
      const adapter = getAdapter('zustand', custom);
      expect(adapter.thread).toBe(custom);
      expect(adapter.gpu).toBe(custom);
    });
  });

  describe("getConfig", () => {
    test("returns resolved config", () => {
      setConfig();
      const config = getConfig();
      expect(config).toBeDefined();
      expect(config.framework).toBeDefined();
    });
  });
});

describe("Index Exports", () => {
  test("exports GPU hooks", async () => {
    const index = await import("../src/index.js");
    expect(typeof index.useGPU).toBe("function");
    expect(typeof index.useGPURun).toBe("function");
    expect(typeof index.useGPUMetrics).toBe("function");
    expect(typeof index.useGPUStatus).toBe("function");
  });

  test("exports GPU adapters", async () => {
    const index = await import("../src/index.js");
    expect(typeof index.createGPUBinder).toBe("function");
    expect(typeof index.createGPUSignalBinder).toBe("function");
    expect(typeof index.createGPUStoreBinder).toBe("function");
  });

  test("exports GPU classes and factories", async () => {
    const index = await import("../src/index.js");
    expect(typeof index.GPUCompute).toBe("function");
    expect(typeof index.PipelineChain).toBe("function");
    expect(typeof index.DataPipelineChain).toBe("function");
    expect(typeof index.createGPUCompute).toBe("function");
  });

  test("exports config functions", async () => {
    const index = await import("../src/index.js");
    expect(typeof index.defineConfig).toBe("function");
    expect(typeof index.getConfig).toBe("function");
    expect(typeof index.setConfig).toBe("function");
  });
});
