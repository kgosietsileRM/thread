/**
 * @file Pipeline chaining classes for GPU compute.
 *
 * Provides {@link PipelineChain} and {@link DataPipelineChain} for
 * fluent, sequential GPU operation composition.
 *
 * @module gpu-chains
 */

import { GPUComputeError } from './error.js';
import { boxAll, isOldRunFormat, jsToWgsl, getParamNames } from './gpu-helpers.js';

// ---------------------------------------------------------------------------
// PipelineChain — fluent API for chaining GPU operations
// ---------------------------------------------------------------------------

/**
 * Fluent pipeline chain for sequencing GPU operations.
 *
 * Created by {@link GPUCompute.pipe}.  Each method queues an operation,
 * and `.result()` executes them all sequentially, feeding outputs
 * as inputs to the next step.
 *
 * @example
 * ```js
 * const chain = gpu.pipe()
 *   .multiply({ inputs: { a: data }, uniforms: { b: new Float32Array([2.0]) } })
 *   .add({ uniforms: { b: new Float32Array([1.0]) } })
 *   .sqrt();
 *
 * const output = await chain.result();
 * // output.result → Float32Array
 * ```
 */
export class PipelineChain {
  /**
   * Create a new pipeline chain.
   *
   * @param {import('./gpu.js').GPUCompute} gpu - GPUCompute instance.
   */
  constructor(gpu) {
    /** @type {import('./gpu.js').GPUCompute} */
    this._gpu = gpu;

    /** @type {Array<{ name: string, input: Object }>} */
    this._steps = [];
  }

  /**
   * Add an operation to the chain.
   *
   * Accepts any of these forms:
   * - `add('op', { inputs: {...}, uniforms: {...} })` — old format
   * - `add('op', { a: data }, { b: scalar })` — new flat format
   * - `add(x => Math.sqrt(x))` — JS function (auto-named, single input)
   *
   * @param {string|Function} nameOrFn - Operation name or JS function.
   * @param {Object} [inputsOrSpec={}] - Input data (flat) or old-format spec.
   * @param {Object} [uniforms={}] - Uniform values (flat).
   * @returns {PipelineChain} This chain (for chaining).
   */
  add(nameOrFn, inputsOrSpec = {}, uniforms = {}) {
    // JS function shorthand: add(x => sqrt(x))
    if (typeof nameOrFn === 'function') {
      const fn = nameOrFn;
      const inputNames = getParamNames(fn);
      const wgslBody = jsToWgsl(fn);
      const opName = `_pipe_${wgslBody.replace(/\W+/g, '_').slice(0, 32)}`;

      // Build CPU fallback
      const cpuFn = async (input) => {
        const src = input.inputs[inputNames[0]];
        const result = new Float32Array(src.length);
        for (let i = 0; i < src.length; i++) result[i] = fn(src[i]);
        return { result };
      };

      this._gpu.define(opName, {
        inputs: inputNames,
        outputs: ['result'],
        body: `result[i] = ${wgslBody};`,
        fn: cpuFn,
      });

      this._steps.push({ name: opName, input: {} });
      return this;
    }

    // Named op
    let input;
    if (isOldRunFormat(inputsOrSpec)) {
      input = inputsOrSpec;
    } else {
      input = { inputs: boxAll(inputsOrSpec), uniforms: boxAll(uniforms) };
    }
    this._steps.push({ name: nameOrFn, input });
    return this;
  }

  /**
   * Execute all queued operations sequentially.
   *
   * Each step's output is merged into the next step's inputs.
   * The final step's output is returned.
   *
   * @param {Object} [opts={}]
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @returns {Promise<Object<string, TypedArray>>}
   */
  async result(opts = {}) {
    if (this._steps.length === 0) {
      throw new GPUComputeError('Pipeline chain is empty — add steps first');
    }

    // Seed initial inputs from opts (e.g. result({ inputs: { data } }))
    let carriedOutputs = {};
    if (opts.inputs) {
      carriedOutputs = boxAll(opts.inputs);
    }

    for (let i = 0; i < this._steps.length; i++) {
      const { name, input } = this._steps[i];

      if (opts.signal?.aborted) {
        throw new GPUComputeError('Pipeline chain cancelled', opts.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }

      // Look up op definition to know its expected input names
      const opDef = this._gpu._ops?.get(name);
      const expectedInputs = opDef?.inputs || [];

      // Remap carried outputs to match the op's expected input names
      // If op expects `x` but carried has `result`, map result → x
      let remappedCarried = { ...carriedOutputs };
      if (expectedInputs.length === 1) {
        const expectedName = expectedInputs[0];
        if (!(expectedName in remappedCarried) && Object.keys(remappedCarried).length === 1) {
          const [onlyKey] = Object.keys(remappedCarried);
          if (onlyKey !== expectedName) {
            remappedCarried = { [expectedName]: remappedCarried[onlyKey] };
          }
        }
      }

      // Merge: explicit step inputs > remapped carried outputs
      const mergedInput = {
        ...input,
        inputs: { ...remappedCarried, ...(input.inputs || {}) },
        signal: opts.signal,
      };

      // If user provided outputs in opts, only pass them for the first step
      if (i === 0 && opts.outputs) {
        mergedInput.outputs = opts.outputs;
      }

      const result = await this._gpu.run(name, mergedInput);
      carriedOutputs = result;
    }

    return carriedOutputs;
  }

  /**
   * Number of steps in the chain.
   *
   * @type {number}
   */
  get length() {
    return this._steps.length;
  }
}

// ---------------------------------------------------------------------------
// DataPipelineChain — pipe(data, count) with Proxy-based named methods
// ---------------------------------------------------------------------------

/**
 * A pipeline chain that carries initial data and supports named methods.
 *
 * Created by `gpu.pipe(data, count)`.  Predefined ops become methods
 * via a Proxy, and `.result()` executes the chain.
 *
 * @example
 * ```js
 * const output = await gpu.pipe(new Float32Array([1, 2, 3]), 3)
 *   .ema({ alpha: 0.3 })
 *   .double()
 *   .result();
 * // output.result → Float32Array
 * ```
 */
export class DataPipelineChain extends PipelineChain {
  /**
   * @param {import('./gpu.js').GPUCompute} gpu
   * @param {TypedArray} data - Initial input data.
   * @param {number} count - Element count.
   */
  constructor(gpu, data, count) {
    super(gpu);
    /** @type {TypedArray} */
    this._data = data;
    /** @type {number} */
    this._count = count;
  }

  /**
   * Execute all queued operations with the carried data.
   *
   * The first step receives `this._data` as its first input.
   * Subsequent steps receive the previous step's output.
   *
   * @param {Object} [opts={}]
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @returns {Promise<Object<string, TypedArray>>}
   */
  async result(opts = {}) {
    if (this._steps.length === 0) {
      throw new GPUComputeError('Pipeline chain is empty — add steps first');
    }

    // Seed with the carried data, mapped to the first step's expected input name
    const firstOpDef = this._gpu._ops?.get(this._steps[0].name);
    const firstName = firstOpDef?.inputs?.[0] || 'data';
    let carriedOutputs = { [firstName]: this._data };

    for (let i = 0; i < this._steps.length; i++) {
      const { name, input } = this._steps[i];

      if (opts.signal?.aborted) {
        throw new GPUComputeError('Pipeline chain cancelled', opts.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }

      const opDef = this._gpu._ops?.get(name);
      const expectedInputs = opDef?.inputs || [];

      // Remap carried outputs to match the op's expected input names
      let remappedCarried = { ...carriedOutputs };
      if (expectedInputs.length === 1) {
        const expectedName = expectedInputs[0];
        if (!(expectedName in remappedCarried) && Object.keys(remappedCarried).length === 1) {
          const [onlyKey] = Object.keys(remappedCarried);
          if (onlyKey !== expectedName) {
            remappedCarried = { [expectedName]: remappedCarried[onlyKey] };
          }
        }
      }

      const mergedInput = {
        ...input,
        inputs: { ...remappedCarried, ...(input.inputs || {}) },
        signal: opts.signal,
      };

      const result = await this._gpu.run(name, mergedInput);
      carriedOutputs = result;
    }

    return carriedOutputs;
  }
}
