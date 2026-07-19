/**
 * @file GPU environment detection and platform-specific adapters.
 *
 * Detects WebGPU support across browser, Node.js, Deno, and Edge
 * environments.  Provides a unified interface for requesting GPU
 * adapters and devices regardless of the runtime.
 *
 * **Supported environments:**
 * - **Browser** — `navigator.gpu.requestAdapter()`
 * - **Node.js** — `@aspect-build/webgpu-node`, `node-webgpu`, or GPUProcess
 * - **Bun** — Bun's built-in WebGPU (experimental) or Node.js bindings
 * - **Deno** — `Deno.gpu` (Deno's built-in WebGPU)
 * - **Edge** — Browser-compatible WebGPU (Cloudflare, Vercel)
 *
 * @example
 * ```js
 * import { gpuEnv, requestGPUAdapter, isGPUAvailable } from './env.js';
 *
 * if (await isGPUAvailable()) {
 *   const adapter = await requestGPUAdapter({ powerPreference: 'high-performance' });
 *   const device = await adapter.requestDevice();
 *   // Use device for compute shaders...
 * } else {
 *   console.warn('WebGPU not available — falling back to CPU');
 * }
 * ```
 *
 * @module gpu/env
 */

import { env } from '../env.js';

// ---------------------------------------------------------------------------
// GPU detection (cached)
// ---------------------------------------------------------------------------

/** @type {Promise<boolean>|null} Cached GPU availability check. */
let _gpuCheckPromise = null;

/**
 * Check if WebGPU is available in the current environment.
 *
 * This performs async detection (some runtimes require `await` to
 * determine GPU availability).  The result is cached after the first call.
 *
 * @returns {Promise<boolean>} `true` if WebGPU is available and usable.
 *
 * @example
 * ```js
 * if (await isGPUAvailable()) {
 *   const gpu = new GPUCompute({ shader: myShader });
 *   await gpu.init();
 * }
 * ```
 */
export async function isGPUAvailable() {
  if (_gpuCheckPromise) return _gpuCheckPromise;
  _gpuCheckPromise = _checkGPU();
  return _gpuCheckPromise;
}

/**
 * @private
 */
async function _checkGPU() {
  // --- Browser / Edge ---
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      return !!adapter;
    } catch {
      return false;
    }
  }

  // --- Deno ---
  if (env.isDeno && typeof Deno !== 'undefined' && Deno.gpu) {
    try {
      const adapter = await Deno.gpu.requestAdapter({ powerPreference: 'high-performance' });
      return !!adapter;
    } catch {
      return false;
    }
  }

  // --- Node.js / Bun — try dynamic imports of WebGPU bindings ---
  if (env.isNode || env.isBun) {
    return await _checkNodeGPU();
  }

  return false;
}

/**
 * @private
 */
async function _checkNodeGPU() {
  // Try various Node.js WebGPU implementations
  const candidates = [
    '@aspect-build/webgpu-node',
    'node-webgpu',
    '@aspect-build/webgpu',
  ];

  for (const pkg of candidates) {
    try {
      const mod = await import(pkg);
      if (mod && (mod.gpu || mod.navigator?.gpu || mod.default?.gpu)) {
        return true;
      }
    } catch {
      // Not installed — try next
    }
  }

  // Try Bun's built-in (if available in the future)
  if (env.isBun) {
    try {
      if (typeof globalThis.Bun?.gpu !== 'undefined') return true;
    } catch { /* ignore */ }

    // Try bun-webgpu (Dawn FFI bindings for Bun)
    try {
      const mod = await import('bun-webgpu');
      if (mod && typeof mod.setupGlobals === 'function') {
        mod.setupGlobals();
        return typeof navigator !== 'undefined' && !!navigator.gpu;
      }
    } catch { /* not installed */ }
  }

  return false;
}

/**
 * Synchronous GPU availability check.
 *
 * Returns `true` if the `navigator.gpu` API is present in the global
 * scope, or if `Bun.gpu` is available (Bun's experimental built-in).
 * This is a fast, synchronous check — it does NOT verify that a GPU
 * adapter can actually be obtained.  Use {@link isGPUAvailable} for
 * a reliable async check.
 *
 * @returns {boolean} `true` if `navigator.gpu` or `Bun.gpu` exists.
 */
export function isGPUSync() {
  if (typeof navigator !== 'undefined' && navigator.gpu) return true;
  if (env.isDeno && typeof Deno !== 'undefined' && Deno.gpu) return true;
  if (env.isBun && typeof globalThis.Bun !== 'undefined' && globalThis.Bun.gpu) return true;
  return false;
}

// ---------------------------------------------------------------------------
// GPU adapter request
// ---------------------------------------------------------------------------

/**
 * Request a GPU adapter from the current environment.
 *
 * Abstracts the differences between browser `navigator.gpu`,
 * Deno `Deno.gpu`, and Node.js WebGPU bindings.
 *
 * @param {Object} [options={}]
 * @param {'low-power'|'high-performance'|undefined} [options.powerPreference]
 * @param {Object} [options.forceFallbackAdapter] - Force software renderer.
 * @returns {Promise<GPUAdapter|null>} The requested adapter, or `null`.
 *
 * @example
 * ```js
 * const adapter = await requestGPUAdapter({
 *   powerPreference: 'high-performance',
 * });
 *
 * if (adapter) {
 *   const device = await adapter.requestDevice();
 *   // Ready for compute shaders
 * }
 * ```
 */
export async function requestGPUAdapter(options = {}) {
  const { powerPreference = 'high-performance', ...rest } = options;

  // --- Browser ---
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      return await navigator.gpu.requestAdapter({ powerPreference, ...rest });
    } catch {
      return null;
    }
  }

  // --- Deno ---
  if (env.isDeno && typeof Deno !== 'undefined' && Deno.gpu) {
    try {
      return await Deno.gpu.requestAdapter({ powerPreference, ...rest });
    } catch {
      return null;
    }
  }

  // --- Node.js ---
  if (env.isNode || env.isBun) {
    return await _requestNodeGPUAdapter(options);
  }

  return null;
}

/**
 * @private
 */
async function _requestNodeGPUAdapter(options) {
  const candidates = [
    'bun-webgpu',
    '@aspect-build/webgpu-node',
    'node-webgpu',
    '@aspect-build/webgpu',
    'webgpu',
  ];

  for (const pkg of candidates) {
    try {
      const mod = await import(pkg);
      // bun-webgpu requires setupGlobals() to set navigator.gpu
      if (pkg === 'bun-webgpu' && typeof mod.setupGlobals === 'function') {
        mod.setupGlobals();
      }
      const gpu = mod.gpu || mod.navigator?.gpu || mod.default?.gpu || (typeof navigator !== 'undefined' && navigator.gpu);
      if (gpu && typeof gpu.requestAdapter === 'function') {
        return await gpu.requestAdapter(options);
      }
    } catch {
      // Not available
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// GPU info / diagnostics
// ---------------------------------------------------------------------------

/**
 * Get a diagnostic snapshot of GPU support in the current environment.
 *
 * Useful for debugging GPU availability issues.
 *
 * @returns {Promise<Object>} Diagnostic information.
 *
 * @example
 * ```js
 * const info = await gpuInfo();
 * console.log(info);
 * // {
 *   available: true,
 *   runtime: 'browser',
 *   adapterName: 'NVIDIA GeForce RTX 4090',
 *   features: ['timestamp-query', 'shader-f16'],
 *   limits: { maxBufferSize: 2147483648, ... },
 *   fallback: false
 * }
 * ```
 */
export async function gpuInfo() {
  const available = await isGPUAvailable();
  const info = {
    available,
    runtime: env.runtime,
    adapterName: null,
    features: [],
    limits: {},
    fallback: false,
  };

  if (!available) return info;

  try {
    const adapter = await requestGPUAdapter({ powerPreference: 'low-power' });
    if (adapter) {
      info.adapterName = adapter.name || 'unknown';
      info.features = [...(adapter.features || [])];
      info.limits = adapter.limits || {};
    }
  } catch { /* ignore */ }

  return info;
}

/**
 * Request a GPU device with sensible defaults.
 *
 * Convenience wrapper around {@link requestGPUAdapter} that also
 * requests a device.  Returns both the adapter and device.
 *
 * @param {Object} [options={}]
 * @param {'low-power'|'high-performance'} [options.powerPreference]
 * @param {Object} [options.requiredLimits] - Minimum device limits.
 * @returns {Promise<{ adapter: GPUAdapter, device: GPUDevice }|null>}
 *   Adapter and device, or `null` if unavailable.
 *
 * @example
 * ```js
 * const result = await requestGPUDevice({ powerPreference: 'high-performance' });
 * if (result) {
 *   const { device } = result;
 *   const buffer = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE });
 * }
 * ```
 */
export async function requestGPUDevice(options = {}) {
  const { requiredLimits, ...adapterOptions } = options;
  const adapter = await requestGPUAdapter(adapterOptions);
  if (!adapter) return null;

  try {
    const device = await adapter.requestDevice({
      requiredLimits: requiredLimits || {},
    });

    // Handle device loss
    device.lost.then((info) => {
      // Device lost — caller should handle re-init
    });

    return { adapter, device };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GPU environment object (unified interface)
// ---------------------------------------------------------------------------

/**
 * Comprehensive GPU environment information.
 *
 * @type {{
 *   available: boolean,
 *   sync: boolean,
 *   runtime: string,
 *   isBrowser: boolean,
 *   isNode: boolean,
 *   isDeno: boolean,
 *   requestAdapter: typeof requestGPUAdapter,
 *   requestDevice: typeof requestGPUDevice,
 *   info: typeof gpuInfo,
 * }}
 */
export const gpuEnv = Object.freeze({
  /** @type {boolean} Async GPU availability check (cached). */
  get available() { return isGPUAvailable(); },
  /** @type {boolean} Sync check for `navigator.gpu`. */
  get sync() { return isGPUSync(); },
  /** @type {string} Current runtime identifier. */
  runtime: env.runtime,
  /** @type {boolean} `true` if in a browser environment. */
  isBrowser: env.isBrowser,
  /** @type {boolean} `true` if in Node.js or Bun. */
  isNode: env.isNode || env.isBun,
  /** @type {boolean} `true` if in Deno. */
  isDeno: env.isDeno,
  /** Request a GPU adapter. */
  requestAdapter: requestGPUAdapter,
  /** Request a GPU device. */
  requestDevice: requestGPUDevice,
  /** Get diagnostic info. */
  info: gpuInfo,
});

export default gpuEnv;
