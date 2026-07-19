/**
 * @file Deno-specific entry point for the thread library.
 *
 * This entry point is optimised for Deno runtimes.  It:
 *
 * 1. Uses Deno's Worker API (Blob URL-based)
 * 2. Uses `Deno.readTextFileSync` for config loading
 * 3. Uses `Deno.gpu` for WebGPU access
 *
 * **Usage:**
 *
 * ```ts
 * // In your Deno project
 * import { Thread, ThreadPool, GPUCompute } from 'jsr:@peach/thread/deno';
 * // or from npm:
 * import { Thread, ThreadPool, GPUCompute } from 'thread/deno';
 * ```
 *
 * @module thread/deno
 */

// Re-export everything from the main entry point
export * from './index.js';
export { default } from './index.js';

// Re-export environment-specific utilities
export { env } from './env.js';
export { createWorker, terminateWorker, supportsWorkers, workerInfo } from './worker-factory.js';
export { gpuEnv, isGPUAvailable, requestGPUAdapter, requestGPUDevice } from './gpu/env.js';
