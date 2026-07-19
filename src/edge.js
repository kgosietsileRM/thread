/**
 * @file Edge runtime entry point for the thread library.
 *
 * This entry point is optimised for edge runtimes (Cloudflare Workers,
 * Vercel Edge, Netlify Edge, Deno Deploy).  It:
 *
 * 1. Uses the standard Web Worker API (Blob URLs)
 * 2. Skips file-based config loading (use `setProgrammaticConfig`)
 * 3. Uses browser-compatible WebGPU detection
 *
 * **Usage:**
 *
 * ```js
 * // In your edge function
 * import { Thread, ThreadPool, GPUCompute } from 'thread/edge';
 * import { setProgrammaticConfig } from 'thread/config';
 *
 * // Set config programmatically (no filesystem in edge)
 * setProgrammaticConfig({
 *   framework: 'react',
 *   stateManager: 'zustand',
 * });
 * ```
 *
 * @module thread/edge
 */

// Re-export everything from the main entry point
export * from './index.js';
export { default } from './index.js';

// Re-export environment-specific utilities
export { env } from './env.js';
export { createWorker, terminateWorker, supportsWorkers, workerInfo } from './worker-factory.js';
export { gpuEnv, isGPUAvailable, requestGPUAdapter, requestGPUDevice } from './gpu/env.js';

// Re-export programmatic config helpers (critical for edge environments)
export { setProgrammaticConfig, getProgrammaticConfig, clearProgrammaticConfig } from './config/index.js';
