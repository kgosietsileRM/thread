/**
 * @file Node.js-specific entry point for the thread library.
 *
 * This entry point is optimised for Node.js and Bun runtimes.  It:
 *
 * 1. Uses `worker_threads` for Worker creation (not Blob URLs)
 * 2. Loads config from the filesystem (`fs.readFileSync`)
 * 3. Supports dynamic `import()` for GPU bindings
 *
 * **Usage:**
 *
 * ```js
 * // In your Node.js project
 * import { Thread, ThreadPool, GPUCompute } from 'thread/node';
 * ```
 *
 * Or in `package.json`:
 * ```json
 * {
 *   "imports": {
 *     "#thread": "thread/node"
 *   }
 * }
 * ```
 *
 * @module thread/node
 */

// Re-export everything from the main entry point
export * from './index.js';
export { default } from './index.js';

// Re-export environment-specific utilities
export { env } from './env.js';
export { createWorker, terminateWorker, supportsWorkers, workerInfo } from './worker-factory.js';
export { gpuEnv, isGPUAvailable, requestGPUAdapter, requestGPUDevice } from './gpu/env.js';
