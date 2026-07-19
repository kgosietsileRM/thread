/**
 * @file WebGPU compute shader integration for the thread module.
 *
 * `GPUCompute` wraps the WebGPU API to provide a high-level interface
 * for running compute shaders.  It manages device acquisition, buffer
 * lifecycle, pipeline creation, and data transfer automatically.
 *
 * @module gpu
 */

import { Metrics } from '../metrix.js';
import { GPUComputeError } from '../error.js';
import { buildShader, BUILT_IN_OPS, SPECIAL_OPS } from './shaders.js';
import {
  OUTPUT_TYPES, resolveType, box, boxAll, isOldRunFormat,
  transpileExpression, transpileDefineBody, jsToWgsl, getParamNames,
} from './helpers.js';
import { PipelineChain, DataPipelineChain } from './chains.js';
import { runSpecial } from './special.js';
import { gpuEnv, requestGPUAdapter } from './env.js';

// Re-export everything from sub-modules for backward compatibility
export { OUTPUT_TYPES, resolveType, box, boxAll, isOldRunFormat,
  transpileExpression, transpileDefineBody, jsToWgsl, getParamNames } from './helpers.js';
export { PipelineChain, DataPipelineChain } from './chains.js';
export { runSpecial, runMatmul, buildMatmulShader, runReduce, getReduceBody,
  runHistogram, runArgMaxMin, runScan } from './special.js';

// ---------------------------------------------------------------------------
// GPUCompute class
// ---------------------------------------------------------------------------

/**
 * WebGPU compute shader executor.
 *
 * Manages the full GPU lifecycle: device, pipelines, buffers, and
 * dispatch.  Designed to integrate with the thread module's metrics
 * and error patterns.
 */
export class GPUCompute {
  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * Create a GPU compute instance.
   *
   * Device acquisition is **lazy** — it happens on the first call to
   * {@link GPUCompute.compute} (or eagerly via {@link GPUCompute.init}).
   *
   * @param {import('../types.js').GPUComputeOptions} options
   * @throws {TypeError} If `options.shader` is missing or not a string.
   */
  constructor(options = {}) {
    if (options.shader && typeof options.shader !== 'string') {
      throw new TypeError('options.shader must be a string');
    }

    /** @type {string|null} Default WGSL compute shader source. */
    this._shader = options.shader || null;

    /** @type {number} Workgroup size (must match @workgroup_size in shader). */
    this._workgroupSize = options.workgroupSize || 256;

    /** @type {number} Maximum buffer size in bytes (default 256 MB). */
    this._maxBufferSize = options.maxBufferSize || 256 * 1024 * 1024;

    /** @type {string} Shader entry point function name. */
    this._entryPoint = options.entryPoint || 'main';

    /** @type {Object} GPU request adapter options. */
    this._adapterOptions = options.adapterOptions || {};

    /** @type {'low-power'|'high-performance'|undefined} GPU power preference. */
    this._powerPreference = options.powerPreference || 'high-performance';

    // Internal state
    this._device = null;
    this._bufferPool = new Map();
    this._isInitialised = false;
    this._initPromise = null;
    this._metrics = new Metrics();
    this._bytesTransferred = 0;
    this._dispatchCount = 0;

    /** @type {Function | null} CPU fallback function. */
    this._cpuFallback = options.cpuFallback || null;

    /** @type {boolean} Whether WebGPU is available. */
    this._available = gpuEnv.sync;

    /** @type {'idle'|'running'|'error'|'unavailable'} Current status. */
    this._status = this._available ? 'idle' : 'unavailable';

    /**
     * Pipeline registry: name -> { shaderSource, pipeline, entryPoint }.
     * @type {Map<string, { shader: string, pipeline: any|null, entryPoint: string }>}
     */
    this._pipelines = new Map();

    /** @type {string} Name of the currently active pipeline. */
    this._activePipeline = 'default';

    // Register the default shader if provided
    if (options.shader) {
      this._pipelines.set('default', {
        shader: options.shader,
        pipeline: null,
        entryPoint: this._entryPoint,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Initialise the GPU device and compile all registered shaders.
   *
   * @returns {Promise<void>}
   * @throws {GPUComputeError} If WebGPU is unavailable, adapter request
   *   fails, or shader compilation fails.
   */
  async init() {
    if (this._isInitialised) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    await this._initPromise;
  }

  /** @private */
  async _doInit() {
    // Re-check availability asynchronously (some runtimes need async check)
    if (!this._available) {
      const asyncAvailable = await gpuEnv.available;
      if (!asyncAvailable) {
        this._status = 'unavailable';
        throw new GPUComputeError(
          'WebGPU is not available in this environment. ' +
          'Ensure your runtime supports WebGPU (browser, Node.js with bindings, or Deno).',
        );
      }
      this._available = true;
    }

    let adapter;
    try {
      adapter = await requestGPUAdapter({
        powerPreference: this._powerPreference,
        ...this._adapterOptions,
      });
    } catch (err) {
      this._status = 'error';
      throw new GPUComputeError('Failed to request GPU adapter', err);
    }

    if (!adapter) {
      this._status = 'error';
      throw new GPUComputeError(
        'Failed to obtain a GPU adapter. Your hardware may not support WebGPU.',
      );
    }

    this._device = await adapter.requestDevice();
    this._device.lost.then((info) => {
      this._status = 'unavailable';
      this._device = null;
      this._pipelines.forEach((p) => { p.pipeline = null; });
      this._isInitialised = false;
    });

    // Compile all registered shaders
    for (const [name, entry] of this._pipelines) {
      entry.pipeline = await this._compileShader(entry.shader, entry.entryPoint, name);
    }

    this._isInitialised = true;
    this._status = 'idle';
  }

  /**
   * Compile a single shader and create its pipeline.
   *
   * @param {string} shaderSource - WGSL source code.
   * @param {string} entryPoint - Entry point function name.
   * @param {string} pipelineName - Name for error messages.
   * @returns {Promise<GPUComputePipeline>}
   * @private
   */
  async _compileShader(shaderSource, entryPoint, pipelineName) {
    const shaderModule = this._device.createShaderModule({ code: shaderSource });

    // getCompilationInfo() is not implemented in all runtimes (e.g. bun-webgpu).
    // Wrap in try/catch — shader errors will surface at pipeline creation time.
    try {
      const compilationInfo = await shaderModule.getCompilationInfo();
      const errors = compilationInfo.messages.filter((m) => m.type === 'error');
      if (errors.length > 0) {
        const details = errors.map((e) => `  line ${e.lineNum}: ${e.message}`).join('\n');
        throw new GPUComputeError(
          `Shader "${pipelineName}" compilation failed:\n${details}`,
        );
      }
    } catch (err) {
      if (err instanceof GPUComputeError) throw err;
      // Runtime doesn't support getCompilationInfo() — continue
    }

    return this._device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Pipeline management
  // -----------------------------------------------------------------------

  /**
   * Register a named shader for later use.
   *
   * @param {string} name - Unique pipeline name (e.g. `'multiply'`).
   * @param {string} shaderSource - WGSL shader source code.
   * @param {Object} [opts={}]
   * @param {string} [opts.entryPoint='main'] - Entry point function name.
   * @returns {Promise<void>}
   */
  async addShader(name, shaderSource, opts = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('Pipeline name must be a non-empty string');
    }
    if (typeof shaderSource !== 'string' || !shaderSource) {
      throw new TypeError('Shader source must be a non-empty string');
    }
    if (this._pipelines.has(name)) {
      throw new Error(`Pipeline "${name}" already exists. Use setActive() to switch.`);
    }

    const entryPoint = opts.entryPoint || 'main';
    this._pipelines.set(name, { shader: shaderSource, pipeline: null, entryPoint });

    if (this._isInitialised && this._device) {
      const entry = this._pipelines.get(name);
      entry.pipeline = await this._compileShader(shaderSource, entryPoint, name);
    }
  }

  /**
   * Remove a registered shader.
   *
   * @param {string} name - Pipeline name to remove.
   */
  removeShader(name) {
    if (name === 'default') throw new Error('Cannot remove the default pipeline');
    if (!this._pipelines.has(name)) {
      throw new Error(`Pipeline "${name}" does not exist`);
    }
    this._pipelines.delete(name);
    if (this._activePipeline === name) this._activePipeline = 'default';
  }

  /**
   * Switch the active pipeline for subsequent `compute()` calls.
   *
   * @param {string} name - Pipeline name (must be registered).
   */
  setActive(name) {
    if (!this._pipelines.has(name)) {
      throw new Error(`Pipeline "${name}" does not exist`);
    }
    this._activePipeline = name;
  }

  /** @type {string} Name of the currently active pipeline. */
  get activePipeline() {
    return this._activePipeline;
  }

  /** @type {string[]} List of all registered pipeline names. */
  get pipelines() {
    return [...this._pipelines.keys()];
  }

  // -----------------------------------------------------------------------
  // define() — register ops from declarations (NO WGSL needed)
  // -----------------------------------------------------------------------

  /**
   * Register a compute operation from a simple declaration or JS function.
   *
   * @param {string} name - Operation name.
   * @param {import('../types.js').OpDeclaration|Function} declarationOrFn
   */
  define(name, declarationOrFn) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('Op name must be a non-empty string');
    }

    // --- Function overload: define(name, (data, { alpha }) => expr) ---
    if (typeof declarationOrFn === 'function') {
      const fn = declarationOrFn;
      const paramNames = getParamNames(fn);

      const inputName = paramNames[0] || 'data';
      let uniformNames = [];
      if (paramNames.length > 1) {
        const src = fn.toString();
        const secondParamMatch = src.match(/\([^)]*,\s*\(?(\{[^}]+\})/);
        if (secondParamMatch) {
          uniformNames = secondParamMatch[1]
            .replace(/[{}]/g, '')
            .split(',')
            .map(s => s.trim().split(':')[0].trim())
            .filter(Boolean);
        }
      }

      const wgslBody = transpileDefineBody(fn, inputName);

      const cpuFn = async (input) => {
        const data = input.inputs[inputName];
        const count = data.byteLength / (data.BYTES_PER_ELEMENT || 4);
        const result = new Float32Array(count);
        const uniformObj = {};
        for (const uName of uniformNames) {
          uniformObj[uName] = input.uniforms?.[uName]?.[0] ?? 0;
        }
        for (let i = 0; i < count; i++) {
          const proxy = { value: data[i], index: i, i };
          result[i] = fn(proxy, uniformObj);
        }
        return { result };
      };

      const decl = {
        inputs: [inputName],
        outputs: ['result'],
        uniforms: uniformNames,
        body: `result[i] = ${wgslBody};`,
        fn: cpuFn,
      };

      return this.define(name, decl);
    }

    // --- Object overload: define(name, { inputs, body, ... }) ---
    const declaration = declarationOrFn;
    if (!declaration || typeof declaration.body !== 'string') {
      throw new TypeError('Op declaration requires a body string or function');
    }

    const {
      inputs = [],
      outputs = ['result'],
      uniforms = [],
      body,
      type = 'f32',
      fn = null,
      workgroupSize,
    } = declaration;

    const wgsl = buildShader({
      inputs,
      outputs,
      uniforms,
      body,
      type,
      workgroupSize: workgroupSize || this._workgroupSize,
    });

    if (!this._ops) this._ops = new Map();
    this._ops.set(name, {
      inputs,
      outputs,
      uniforms,
      type,
      fn,
      _body: body,
      workgroupSize: workgroupSize || this._workgroupSize,
    });

    this._pipelines.set(name, {
      shader: wgsl,
      pipeline: null,
      entryPoint: 'main',
    });
  }

  /**
   * Register a built-in operation by name.
   *
   * @param {string} name - Built-in op name (e.g. `'multiply'`, `'sqrt'`).
   * @param {Object} [opts={}]
   */
  defineBuiltin(name, opts = {}) {
    const op = BUILT_IN_OPS[name];
    if (!op) {
      throw new Error(`Unknown built-in op: "${name}". Available: ${Object.keys(BUILT_IN_OPS).join(', ')}`);
    }
    this.define(name, { ...op, ...opts });
  }

  /**
   * Register all built-in operations at once.
   *
   * @param {Object} [opts={}]
   * @returns {string[]} Names of registered ops.
   */
  defineAllBuiltins(opts = {}) {
    const names = [];
    for (const name of Object.keys(BUILT_IN_OPS)) {
      this.defineBuiltin(name, opts);
      names.push(name);
    }
    return names;
  }

  /** @type {string[]} All defined operation names (built-in + custom). */
  get ops() {
    return this._ops ? [...this._ops.keys()] : [];
  }

  // -----------------------------------------------------------------------
  // run() — high-level entry point (NO WGSL needed)
  // -----------------------------------------------------------------------

  /**
   * Run a named operation.
   *
   * @param {string} name - Operation name.
   * @param {Object} inputsOrOpts
   * @param {Object} [uniformsOrOpts={}]
   * @param {Object} [opts={}]
   * @returns {Promise<Object<string, TypedArray>>}
   */
  async run(name, inputsOrOpts = {}, uniformsOrOpts = {}, opts = {}) {
    let input, signal;
    if (isOldRunFormat(inputsOrOpts)) {
      input = inputsOrOpts;
      signal = input.signal;
    } else {
      input = {
        inputs: boxAll(inputsOrOpts),
        uniforms: boxAll(uniformsOrOpts),
        signal: opts.signal,
        outputType: opts.outputType,
        workgroups: opts.workgroups,
      };
      signal = opts.signal;
    }

    if (signal?.aborted) {
      throw new GPUComputeError('Operation cancelled', signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    const ops = this._ops || new Map();
    let opDef = ops.get(name);
    let builtinDef = BUILT_IN_OPS[name];
    let specialDef = SPECIAL_OPS[name];

    if (!opDef && builtinDef) {
      this.defineBuiltin(name);
      opDef = ops.get(name);
    }

    if (specialDef && !opDef) {
      try {
        return await runSpecial(this, name, specialDef, input);
      } catch (err) {
        this._status = 'idle';
        if (err instanceof GPUComputeError) throw err;
        throw new GPUComputeError(`Special op "${name}" failed: ${err.message}`, err);
      }
    }

    if (!opDef) {
      throw new Error(
        `Unknown operation: "${name}". ` +
        `Use gpu.define() or gpu.defineBuiltin() first, or pick from: ` +
        `[${[...ops.keys(), ...Object.keys(BUILT_IN_OPS), ...Object.keys(SPECIAL_OPS)].join(', ')}]`,
      );
    }

    const {
      inputs: inputNames = [],
      outputs: outputNames = ['result'],
      uniforms: uniformNames = [],
      type = 'f32',
      fn,
    } = opDef;

    let { outputs: outputSpec } = input;
    if (!outputSpec) {
      const firstInputName = inputNames[0];
      const firstInput = input.inputs?.[firstInputName];
      if (firstInput) {
        const count = firstInput.byteLength / (firstInput.BYTES_PER_ELEMENT || 4);
        outputSpec = {};
        for (const outName of outputNames) outputSpec[outName] = count;
      } else {
        throw new GPUComputeError(
          `Cannot auto-size outputs: no input named "${firstInputName}" found`,
        );
      }
    }

    const computeInput = {
      inputs: boxAll(input.inputs || {}),
      uniforms: boxAll(input.uniforms || {}),
      outputBuffers: outputSpec,
      outputType: input.outputType || type,
      workgroups: input.workgroups ?? null,
      signal: input.signal,
    };

    this.setActive(name);

    if (!this._available && fn) {
      return fn(computeInput);
    }

    // If we have a CPU fallback, try GPU first and fall back on error
    // (handles runtimes where adapter exists but dispatch fails, e.g. Dawn/DXC issues)
    if (fn) {
      try {
        return await this.compute(computeInput);
      } catch (err) {
        this._status = 'idle';
        console.warn(`[GPUCompute] GPU dispatch failed for "${name}", using CPU fallback: ${err.message}`);
        return fn(computeInput);
      }
    }

    return this.compute(computeInput);
  }

  // -----------------------------------------------------------------------
  // autoTune() — find optimal workgroup size
  // -----------------------------------------------------------------------

  /**
   * Benchmark different workgroup sizes and return the fastest.
   *
   * @param {string} name - Operation name (must be defined first).
   * @param {Object} input - Sample input for benchmarking.
   * @param {Object} [opts={}]
   * @param {number} [opts.iterations=10] - Number of iterations per size.
   * @param {number[]} [opts.sizes=[32, 64, 128, 256, 512]] - Workgroup sizes to test.
   * @returns {Promise<{ optimal: number, results: Array<{ size: number, avgMs: number }> }>}
   */
  async autoTune(name, input, opts = {}) {
    const { iterations = 10, sizes = [32, 64, 128, 256, 512] } = opts;
    const opDef = this._ops?.get(name);
    if (!opDef) throw new Error(`Unknown operation: "${name}". Define it first with gpu.define().`);

    const results = [];
    for (const size of sizes) {
      const wgsl = buildShader({
        inputs: opDef.inputs,
        outputs: opDef.outputs,
        uniforms: opDef.uniforms,
        body: opDef._body,
        type: opDef.type,
        workgroupSize: size,
      });

      const tempName = `_tune_${name}_${size}`;
      this._pipelines.set(tempName, { shader: wgsl, pipeline: null, entryPoint: 'main' });
      if (this._isInitialised && this._device) {
        const entry = this._pipelines.get(tempName);
        entry.pipeline = await this._compileShader(wgsl, 'main', tempName);
      }

      const times = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        this.setActive(tempName);
        await this.run(name, input);
        times.push(performance.now() - start);
      }

      const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
      results.push({ size, avgMs });

      // Cleanup temp pipeline
      this._pipelines.delete(tempName);
    }

    results.sort((a, b) => a.avgMs - b.avgMs);
    return { optimal: results[0].size, results };
  }

  // -----------------------------------------------------------------------
  // profile() — timing breakdown for pipelines
  // -----------------------------------------------------------------------

  /**
   * Time a sequence of named operations and return per-step breakdowns.
   *
   * @param {Array<{ name: string, input: Object }>} steps
   * @returns {Promise<{ results: Object, steps: Array<{ name: string, ms: number }>, totalMs: number }>}
   */
  async profile(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new TypeError('steps must be a non-empty array');
    }

    const stepResults = [];
    let carriedOutputs = {};
    const startTime = performance.now();

    for (let i = 0; i < steps.length; i++) {
      const { name, input } = steps[i];

      // Merge carried outputs from previous step
      const mergedInput = {
        ...input,
        inputs: { ...carriedOutputs, ...(input.inputs || {}) },
      };

      const start = performance.now();
      const result = await this.run(name, mergedInput);
      const ms = performance.now() - start;

      stepResults.push({ name, ms });
      carriedOutputs = result;
    }

    return {
      results: carriedOutputs,
      steps: stepResults,
      totalMs: performance.now() - startTime,
    };
  }

  // -----------------------------------------------------------------------
  // runMany() — run different ops in parallel
  // -----------------------------------------------------------------------

  /**
   * Run multiple named operations concurrently or sequentially.
   *
   * Accepts either format:
   * - `runMany([{ name, input }, ...], { onProgress })` — array of step specs
   * - `runMany({ op1: input1, op2: input2 })` — object form (keys are op names)
   *
   * @param {Array|Object} tasks
   * @param {Object} [opts={}]
   * @returns {Promise<Array<Object<string, TypedArray>>>}
   */
  async runMany(tasks, opts = {}) {
    if (typeof tasks === 'string' || !tasks) {
      throw new TypeError('tasks must be an array or object');
    }

    if (Array.isArray(tasks)) {
      const { onProgress } = opts;
      const results = [];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        results.push(await this.run(t.name, t.input));
        if (onProgress) onProgress(i + 1, tasks.length);
      }
      return results;
    }

    // Object form: { opName: input, ... }
    const entries = Object.entries(tasks);
    const results = await Promise.all(
      entries.map(([name, input]) => this.run(name, input)),
    );
    return results;
  }

  // -----------------------------------------------------------------------
  // map() — parallel element-wise transform
  // -----------------------------------------------------------------------

  /**
   * Apply a function to every element in parallel on the GPU.
   *
   * @param {TypedArray} data - Input data.
   * @param {string|Function} body - WGSL expression or JS arrow function.
   * @param {Object} [opts={}]
   * @returns {Promise<TypedArray>} Transformed data.
   */
  async map(data, body, opts = {}) {
    if (opts.signal?.aborted) {
      throw new GPUComputeError('Operation cancelled', opts.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    const { outputType = 'f32', signal } = opts;
    const count = data.byteLength / (data.BYTES_PER_ELEMENT || 4);
    const isFn = typeof body === 'function';

    const wgslBody = isFn ? jsToWgsl(body) : body;
    const inputNames = isFn ? getParamNames(body) : ['x_in'];
    const opName = `_map_${wgslBody.replace(/\W+/g, '_').slice(0, 32)}`;

    const inputMap = {};
    inputMap[inputNames[0]] = data;

    const cpuFn = isFn ? async (input) => {
      const src = input.inputs[inputNames[0]];
      const result = new Float32Array(count);
      for (let i = 0; i < count; i++) result[i] = body(src[i]);
      return { result };
    } : null;

    this.define(opName, {
      inputs: inputNames.length === 1 ? [inputNames[0]] : inputNames,
      outputs: ['result'],
      body: `result[i] = ${wgslBody};`,
      type: outputType,
      fn: cpuFn,
    });

    const result = await this.run(opName, {
      inputs: inputMap,
      outputs: { result: count },
      outputType,
      signal,
    });

    return result.result;
  }

  // -----------------------------------------------------------------------
  // pipe() — fluent pipeline chaining API
  // -----------------------------------------------------------------------

  /**
   * Start a fluent pipeline chain.
   *
   * Overloads:
   * - `pipe()` — empty chain
   * - `pipe('op', inputs, uniforms)` — chain starting with a named op
   * - `pipe(fn)` — chain starting with a JS function
   * - `pipe(data, count)` — data-first chain with Proxy-based named methods
   *
   * @returns {PipelineChain|DataPipelineChain}
   */
  pipe(nameOrFn, countOrInput, uniforms, opts) {
    // --- New: pipe(data, count) → Proxy chain with named methods ---
    if (nameOrFn instanceof Float32Array || nameOrFn instanceof Int32Array || nameOrFn instanceof Uint32Array) {
      const data = nameOrFn;
      const count = typeof countOrInput === 'number' ? countOrInput
        : data.byteLength / (data.BYTES_PER_ELEMENT || 4);
      const chain = new DataPipelineChain(this, data, count);

      return new Proxy(chain, {
        get(target, prop, receiver) {
          if (prop === 'result' || prop === 'add' || prop === 'length' || prop === '_steps' || prop === '_gpu' || prop === '_data' || prop === '_count') {
            return Reflect.get(target, prop, receiver);
          }
          if (typeof prop === 'string' && target._gpu._ops?.has(prop)) {
            return (uniformsOrOpts) => {
              const boxedUniforms = boxAll(uniformsOrOpts || {});
              target.add(prop, { inputs: {}, uniforms: boxedUniforms });
              return receiver;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }

    // --- Existing: pipe() / pipe('op', ...) / pipe(fn) ---
    const chain = new PipelineChain(this);
    if (nameOrFn) {
      if (typeof nameOrFn === 'function') {
        chain.add(nameOrFn);
      } else if (typeof nameOrFn === 'string') {
        chain.add(nameOrFn, { inputs: boxAll(countOrInput || {}), uniforms: boxAll(uniforms || {}), ...opts });
      } else if (typeof nameOrFn === 'object' && nameOrFn.name) {
        chain.add(nameOrFn.name, nameOrFn);
      }
    }
    return chain;
  }

  // -----------------------------------------------------------------------
  // runBatch — high-level batch execution
  // -----------------------------------------------------------------------

  /**
   * Run the same operation on many input sets.
   *
   * @param {string} name - Operation name.
   * @param {Array} inputs - Array of input specs or data arrays.
   * @param {Object} [opts={}]
   * @returns {Promise<Array<Object<string, TypedArray>>>}
   */
  async runBatch(name, inputs, opts = {}) {
    if (!Array.isArray(inputs)) throw new TypeError('inputs must be an array');

    // Flat format: runBatch('op', [data1, data2, ...], { uniforms })
    if (inputs.length > 0 && (ArrayBuffer.isView(inputs[0]) || Array.isArray(inputs[0]))) {
      const { onProgress, uniforms = {} } = opts;
      const results = [];
      for (let i = 0; i < inputs.length; i++) {
        const data = inputs[i];
        const firstKey = 'data';
        const result = await this.run(name, {
          inputs: { [firstKey]: box(data) },
          uniforms: boxAll(uniforms),
        });
        results.push(result);
        if (onProgress) onProgress(i + 1, inputs.length);
      }
      return results;
    }

    // Old format: runBatch('op', [{ inputs, uniforms, outputs }, ...])
    const { onProgress } = opts;
    const results = [];
    for (let i = 0; i < inputs.length; i++) {
      const result = await this.run(name, inputs[i]);
      results.push(result);
      if (onProgress) onProgress(i + 1, inputs.length);
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Buffer management
  // -----------------------------------------------------------------------

  /** @private */
  _acquireBuffer(byteLength, usage) {
    const aligned = Math.ceil(Math.max(byteLength, 4) / 64) * 64;
    const key = `${aligned}_${usage}`;
    const pool = this._bufferPool.get(key);
    if (pool && pool.length > 0) return pool.pop();
    return this._device.createBuffer({
      size: aligned,
      usage,
      mappedAtCreation: true,
    });
  }

  /** @private */
  _releaseBuffer(buffer, byteLength, usage) {
    const aligned = Math.ceil(Math.max(byteLength, 4) / 64) * 64;
    const key = `${aligned}_${usage}`;
    if (!this._bufferPool.has(key)) this._bufferPool.set(key, []);
    const pool = this._bufferPool.get(key);
    if (pool.length < 32) pool.push(buffer);
  }

  /** @private */
  _writeBuffer(buffer, data) {
    const byteLength = data.byteLength;
    const srcData = data.buffer.slice(data.byteOffset, data.byteOffset + byteLength);
    this._device.queue.writeBuffer(buffer, 0, srcData, 0, byteLength);
    this._bytesTransferred += byteLength;
  }

  /** @private */
  async _readBuffer(buffer, byteLength, TypedArrayConstructor) {
    const readBuf = this._acquireBuffer(
      byteLength,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );

    const encoder = this._device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, readBuf, 0, byteLength);
    this._device.queue.submit([encoder.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const arrayBuffer = readBuf.getMappedRange();
    const result = new TypedArrayConstructor(arrayBuffer.slice(0, byteLength));
    readBuf.unmap();
    this._releaseBuffer(readBuf, byteLength, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    this._bytesTransferred += byteLength;

    return result;
  }

  /** @private */
  _buildBindGroup({ inputs, uniforms, outputBuffers, outputType }) {
    const entries = [];
    const toRelease = [];
    const outputInfo = {};
    let bindingIndex = 0;

    for (const [name, data] of Object.entries(inputs)) {
      const byteLength = data.byteLength;
      const buf = this._acquireBuffer(byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this._writeBuffer(buf, data);
      entries.push({ binding: bindingIndex, resource: { buffer: buf } });
      toRelease.push({ buffer: buf, byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      bindingIndex++;
    }

    for (const [name, data] of Object.entries(uniforms)) {
      const byteLength = data.byteLength;
      const buf = this._acquireBuffer(byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this._writeBuffer(buf, data);
      entries.push({ binding: bindingIndex, resource: { buffer: buf } });
      toRelease.push({ buffer: buf, byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      bindingIndex++;
    }

    const TypeConstructor = resolveType(outputType);
    const bytesPerElement = TypeConstructor.BYTES_PER_ELEMENT || 4;
    for (const [name, elements] of Object.entries(outputBuffers)) {
      const byteLength = elements * bytesPerElement;
      const buf = this._acquireBuffer(byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      entries.push({ binding: bindingIndex, resource: { buffer: buf } });
      outputInfo[name] = { buffer: buf, byteLength, Constructor: TypeConstructor };
      toRelease.push({ buffer: buf, byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      bindingIndex++;
    }

    return { entries, outputInfo, toRelease };
  }

  /** @private */
  _releaseAll(toRelease) {
    for (const { buffer, byteLength, usage } of toRelease) {
      this._releaseBuffer(buffer, byteLength, usage);
    }
  }

  // -----------------------------------------------------------------------
  // Core compute
  // -----------------------------------------------------------------------

  /**
   * Execute a compute pass on the GPU.
   *
   * @param {import('../types.js').GPUComputeInput} input
   * @returns {Promise<Object<string, TypedArray>>}
   */
  async compute(input) {
    if (!this._isInitialised) await this.init();

    const {
      inputs = {},
      uniforms = {},
      outputBuffers = {},
      outputType = 'f32',
      workgroups = null,
      bindingStart = 0,
    } = input;

    this._status = 'running';
    const startTime = performance.now();

    try {
      const { entries, outputInfo, toRelease } = this._buildBindGroup({
        inputs, uniforms, outputBuffers, outputType,
      });

      if (bindingStart > 0) {
        for (const entry of entries) entry.binding += bindingStart;
      }

      const pipeline = this._pipelines.get(this._activePipeline);
      if (!pipeline || !pipeline.pipeline) {
        throw new GPUComputeError(`Pipeline "${this._activePipeline}" is not compiled`);
      }

      const bindGroup = this._device.createBindGroup({
        layout: pipeline.pipeline.getBindGroupLayout(0),
        entries,
      });

      const maxElements = Math.max(
        ...Object.values(inputs).map((d) => d.byteLength / (d.BYTES_PER_ELEMENT || 4)),
        ...Object.values(outputBuffers).map((e) => e),
        1,
      );
      const wg = workgroups != null ? workgroups : Math.ceil(maxElements / this._workgroupSize);

      const encoder = this._device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(wg, 1, 1);
      pass.end();
      this._device.queue.submit([encoder.finish()]);

      const results = {};
      for (const [name, info] of Object.entries(outputInfo)) {
        results[name] = await this._readBuffer(info.buffer, info.byteLength, info.Constructor);
      }

      this._releaseAll(toRelease);

      const duration = performance.now() - startTime;
      this._metrics.record(duration, true);
      this._dispatchCount++;
      this._status = 'idle';
      return results;
    } catch (err) {
      this._status = 'error';
      const duration = performance.now() - startTime;
      this._metrics.record(duration, false);
      if (err instanceof GPUComputeError) throw err;
      throw new GPUComputeError(`Compute dispatch failed: ${err.message}`, err);
    }
  }

  // -----------------------------------------------------------------------
  // computeMany / computeSequential / computeWithFallback
  // -----------------------------------------------------------------------

  /** @param {import('../types.js').GPUComputeInput[]} batches */
  async computeMany(batches, opts = {}) {
    if (!Array.isArray(batches)) throw new TypeError('batches must be an array');
    const { onProgress = null } = opts;
    const run = this._cpuFallback
      ? (b) => this.computeWithFallback(b)
      : (b) => this.compute(b);
    const results = [];
    for (let i = 0; i < batches.length; i++) {
      results.push(await run(batches[i]));
      if (onProgress) onProgress(i + 1, batches.length);
    }
    return results;
  }

  /** @param {Array} steps */
  async computeSequential(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new TypeError('steps must be a non-empty array');
    }

    const run = this._cpuFallback
      ? (s) => this.computeWithFallback(s)
      : (s) => this.compute(s);
    let carriedOutputs = {};

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.pipeline) this.setActive(step.pipeline);
      const mergedInputs = { ...carriedOutputs, ...(step.inputs || {}) };
      const result = await run({
        inputs: mergedInputs,
        uniforms: step.uniforms || {},
        outputBuffers: step.outputBuffers,
        outputType: step.outputType || 'f32',
        bindingStart: 0,
      });
      carriedOutputs = result;
    }

    return carriedOutputs;
  }

  /** @param {import('../types.js').GPUComputeInput} input */
  async computeWithFallback(input, fallbackOverride = null) {
    if (!this._available) {
      const fb = fallbackOverride || this._cpuFallback;
      if (fb) return fb(input);
      throw new GPUComputeError('WebGPU unavailable and no cpuFallback provided');
    }

    try {
      return await this.compute(input);
    } catch (err) {
      const fb = fallbackOverride || this._cpuFallback;
      if (fb) {
        console.warn('[GPUCompute] GPU failed, using CPU fallback:', err.message);
        return fb(input);
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  destroy() {
    for (const [, pool] of this._bufferPool) {
      for (const buf of pool) {
        try { buf.destroy(); } catch (_) { /* already destroyed */ }
      }
    }
    this._bufferPool.clear();
    if (this._device) {
      this._device.destroy();
      this._device = null;
    }
    this._pipelines.forEach((p) => { p.pipeline = null; });
    this._isInitialised = false;
    this._status = 'unavailable';
  }

  resetMetrics() {
    this._metrics.reset();
    this._bytesTransferred = 0;
    this._dispatchCount = 0;
  }

  // -----------------------------------------------------------------------
  // Inspect
  // -----------------------------------------------------------------------

  inspect() {
    let poolEntries = 0;
    for (const [, pool] of this._bufferPool) poolEntries += pool.length;

    return {
      status: this._status,
      available: this._available,
      ready: this._isInitialised,
      activePipeline: this._activePipeline,
      pipelines: this.pipelines,
      ops: this.ops,
      metrics: this._metrics.snapshot(),
      dispatchCount: this._dispatchCount,
      bytesTransferred: this._bytesTransferred,
      bufferPoolEntries: poolEntries,
      workgroupSize: this._workgroupSize,
      maxBufferSize: this._maxBufferSize,
      powerPreference: this._powerPreference,
    };
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  /** @type {boolean} */
  get available() { return this._available; }

  /** @type {boolean} */
  get ready() { return this._isInitialised; }

  /** @type {'idle'|'running'|'error'|'unavailable'} */
  get status() { return this._status; }

  /** @type {number} */
  get dispatchCount() { return this._dispatchCount; }

  /** @type {number} */
  get bytesTransferred() { return this._bytesTransferred; }

  /** @type {import('../types.js').MetricsSnapshot} */
  get metrics() { return this._metrics.snapshot(); }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a GPUCompute instance.
 *
 * @param {import('../types.js').GPUComputeOptions} options
 * @returns {GPUCompute}
 */
export function createGPUCompute(options) {
  return new GPUCompute(options);
}

/**
 * Create a GPUCompute with a pre-configured CPU fallback.
 *
 * @param {string} shader - WGSL shader source.
 * @param {Function} cpuFunction
 * @param {Object} [options={}]
 * @returns {GPUCompute}
 */
export function createGPUWithFallback(shader, cpuFunction, options = {}) {
  return new GPUCompute({ ...options, shader, cpuFallback: cpuFunction });
}

/**
 * Helper to create an output spec object.
 *
 * @param {string} name - Output buffer name.
 * @param {number} elements - Number of elements.
 * @param {string|typeof TypedArray} [type='f32']
 * @returns {{ outputBuffers: Object<string, number>, outputType: string|typeof TypedArray }}
 */
export function outputSpec(name, elements, type = 'f32') {
  return { outputBuffers: { [name]: elements }, outputType: type };
}

/**
 * Helper to create a uniform spec object.
 *
 * @param {string} name - Uniform binding name.
 * @param {TypedArray} data - Uniform data.
 * @returns {{ uniforms: Object<string, TypedArray> }}
 */
export function uniform(name, data) {
  return { uniforms: { [name]: data } };
}
