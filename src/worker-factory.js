/**
 * @file Cross-platform Worker factory for the thread library.
 *
 * Abstracts Worker creation across:
 * - **Browser** — `new Worker(blobUrl)` with Blob URLs
 * - **Node.js** — `worker_threads.Worker` with `eval` or `data:` URLs
 * - **Bun** — `worker_threads.Worker` (Bun's built-in)
 * - **Deno** — `new Worker(url)` (Deno's Worker API)
 *
 * The factory returns a **unified Worker interface** that exposes the
 * same API (`postMessage`, `terminate`, `onmessage`, `onerror`) regardless
 * of the underlying platform.
 *
 * @example
 * ```js
 * import { createWorker, terminateWorker, postToWorker } from './worker-factory.js';
 *
 * const worker = createWorker(scriptSource, { type: 'module' });
 * worker.onmessage = (e) => console.log(e.data);
 * postToWorker(worker, { id: 1, args: [42] });
 * ```
 *
 * @module worker-factory
 */

import { env } from './env.js';

// ---------------------------------------------------------------------------
// Worker creation
// ---------------------------------------------------------------------------

/**
 * Create a platform-appropriate Worker from a script string.
 *
 * **Browser:** Creates a Blob URL and spawns a standard Web Worker.
 * **Node.js/Bun:** Uses `worker_threads.Worker` with the script as eval code.
 * **Deno:** Uses Deno's Worker API with a Blob URL.
 *
 * @param {string} scriptSource - JavaScript source code for the worker.
 * @param {Object} [options={}]
 * @param {'classic'|'module'} [options.type='classic'] - Script module type.
 * @param {string[]} [options.imports] - URLs to import before running the script.
 * @returns {WorkerInterface} A worker with a unified interface.
 * @throws {Error} If Worker creation fails in the current environment.
 *
 * @example
 * ```js
 * const worker = createWorker(`
 *   self.onmessage = function(e) {
 *     self.postMessage(e.data * 2);
 *   };
 * `);
 *
 * worker.onmessage = (e) => console.log(e.data); // 84
 * worker.postMessage(42);
 * ```
 */
export function createWorker(scriptSource, options = {}) {
  const { type = 'classic', imports = [] } = options;

  // --- Browser ---
  if (env.isBrowser || (env.runtime === 'deno' && !env.isEdge)) {
    return _createBrowserWorker(scriptSource, { type, imports });
  }

  // --- Node.js / Bun ---
  if (env.isNode || env.isBun) {
    return _createNodeWorker(scriptSource, { type, imports });
  }

  // --- Deno (if not caught above) ---
  if (env.isDeno) {
    return _createDenoWorker(scriptSource, { type, imports });
  }

  throw new Error(
    `thread: Worker creation is not supported in this environment (${env.runtime}/${env.context}). ` +
    'Supported: browser, Node.js, Bun, Deno.'
  );
}

// ---------------------------------------------------------------------------
// Browser worker
// ---------------------------------------------------------------------------

/**
 * @private
 */
function _createBrowserWorker(scriptSource, { type, imports }) {
  // Prepend importScripts calls if needed
  let fullScript = scriptSource;
  if (imports.length > 0 && type === 'classic') {
    const importLines = imports.map((u) => `importScripts('${u}');`).join('\n');
    fullScript = importLines + '\n' + scriptSource;
  }

  const blob = new Blob([fullScript], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const worker = new Worker(blobUrl, { type });
    // Attach blob URL for later cleanup
    worker._threadBlobUrl = blobUrl;
    worker._threadType = 'browser';
    return worker;
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Node.js / Bun worker
// ---------------------------------------------------------------------------

/**
 * @private
 */
function _createNodeWorker(scriptSource, { type, imports }) {
  let WorkerClass;

  // Try node:worker_threads first (Node.js with globalThis.require)
  try {
    if (typeof globalThis.require === 'function') {
      const wt = globalThis.require('node:worker_threads');
      WorkerClass = wt.Worker;
    }
  } catch { /* ignore */ }

  // Fallback: try bare require (Bun exposes require but not on globalThis)
  if (!WorkerClass) {
    try {
      if (typeof require === 'function') {
        const wt = require('node:worker_threads');
        WorkerClass = wt.Worker;
      }
    } catch { /* ignore */ }
  }

  if (!WorkerClass) {
    throw new Error('thread: worker_threads module is not available');
  }

  // Build import preamble for Node workers
  let fullScript = scriptSource;
  if (imports.length > 0) {
    const importLines = imports.map((u) => `importScripts('${u}');`).join('\n');
    fullScript = importLines + '\n' + scriptSource;
  }

  // Node worker_threads expects eval or a file path
  // We use eval mode with the script as the worker code
  const worker = new WorkerClass(fullScript, {
    eval: true,
    // Node.js worker_threads needs these for message compatibility
    stdout: false,
    stderr: false,
  });

  // Wrap to match browser Worker API
  const wrapped = _wrapNodeWorker(worker);
  wrapped._threadType = 'node';
  return wrapped;
}

// ---------------------------------------------------------------------------
// Deno worker
// ---------------------------------------------------------------------------

/**
 * @private
 */
function _createDenoWorker(scriptSource, { type, imports }) {
  let fullScript = scriptSource;
  if (imports.length > 0) {
    const importLines = imports.map((u) => `import '${u}';`).join('\n');
    fullScript = importLines + '\n' + scriptSource;
  }

  const blob = new Blob([fullScript], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const worker = new Worker(blobUrl, { type: 'module' });
    worker._threadBlobUrl = blobUrl;
    worker._threadType = 'deno';
    return worker;
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Node.js worker_threads → browser Worker API adapter
// ---------------------------------------------------------------------------

/**
 * Wrap a Node.js `worker_threads.Worker` to expose the browser Worker API.
 *
 * Node's worker_threads uses a different event model (EventEmitter).
 * This wrapper translates `.on('message', ...)` to `.onmessage = ...`.
 *
 * @param {import('worker_threads').Worker} nodeWorker
 * @returns {WorkerInterface} Browser-compatible Worker wrapper.
 * @private
 */
function _wrapNodeWorker(nodeWorker) {
  const wrapped = {
    _nodeWorker: nodeWorker,
    _threadType: 'node',
    _onmessage: null,
    _onerror: null,
    _onmessageerror: null,

    get onmessage() { return this._onmessage; },
    set onmessage(fn) {
      this._onmessage = fn;
      // Node worker_threads uses 'message' event
      nodeWorker.removeAllListeners('message');
      if (fn) {
        nodeWorker.on('message', (data) => {
          // Wrap in a MessageEvent-like object
          fn({ data });
        });
      }
    },

    get onerror() { return this._onerror; },
    set onerror(fn) {
      this._onerror = fn;
      nodeWorker.removeAllListeners('error');
      if (fn) {
        nodeWorker.on('error', (err) => {
          fn({ message: err.message, error: err, preventDefault() {} });
        });
      }
    },

    get onmessageerror() { return this._onmessageerror; },
    set onmessageerror(fn) {
      this._onmessageerror = fn;
      // Node doesn't have messageerror — no-op
    },

    postMessage(data, transfer) {
      // Node worker_threads postMessage
      if (transfer && Array.isArray(transfer)) {
        nodeWorker.postMessage(data, transfer);
      } else {
        nodeWorker.postMessage(data);
      }
    },

    terminate() {
      try { nodeWorker.terminate(); } catch { /* already terminated */ }
    },

    // Bonus: Node-specific APIs for advanced usage
    get threadId() {
      return nodeWorker.threadId;
    },
  };

  // Proxy any other method calls to the underlying worker
  return new Proxy(wrapped, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Delegate to the underlying worker for unknown properties
      const val = nodeWorker[prop];
      return typeof val === 'function' ? val.bind(nodeWorker) : val;
    },
  });
}

// ---------------------------------------------------------------------------
// Worker utilities
// ---------------------------------------------------------------------------

/**
 * Post a message to a worker, handling platform differences.
 *
 * @param {WorkerInterface} worker - The worker to send to.
 * @param {*} data - Message data.
 * @param {Transferable[]} [transfer=[]] - Transferable objects.
 */
export function postToWorker(worker, data, transfer = []) {
  if (worker._threadType === 'node') {
    worker.postMessage(data, transfer);
  } else {
    worker.postMessage(data, transfer);
  }
}

/**
 * Terminate a worker and clean up resources.
 *
 * Revokes Blob URLs (browser/Deno) and terminates the worker.
 *
 * @param {WorkerInterface} worker - The worker to terminate.
 */
export function terminateWorker(worker) {
  // Revoke Blob URL if applicable
  if (worker._threadBlobUrl) {
    try { URL.revokeObjectURL(worker._threadBlobUrl); } catch { /* ignore */ }
  }
  worker.terminate();
}

/**
 * Check if the current environment supports Worker creation.
 *
 * @returns {boolean} `true` if Workers can be created.
 */
export function supportsWorkers() {
  return env.hasWorker || env.isNode || env.isBun || env.isDeno;
}

/**
 * Get a description of the current Worker support.
 *
 * @returns {{ supported: boolean, type: string, details: string }}
 *
 * @example
 * ```js
 * const info = workerInfo();
 * console.log(info); // { supported: true, type: 'browser', details: 'Web Workers via Blob URLs' }
 * ```
 */
export function workerInfo() {
  if (env.isBrowser) {
    return { supported: true, type: 'browser', details: 'Web Workers via Blob URLs' };
  }
  if (env.isBun) {
    return { supported: true, type: 'bun', details: 'Bun worker_threads (eval mode)' };
  }
  if (env.isNode) {
    return { supported: true, type: 'node', details: 'Node.js worker_threads (eval mode)' };
  }
  if (env.isDeno) {
    return { supported: true, type: 'deno', details: 'Deno Workers via Blob URLs' };
  }
  return { supported: false, type: 'none', details: 'No Worker support detected' };
}

// Re-export env for convenience
export { env } from './env.js';
