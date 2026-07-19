/**
 * @file GPU compute barrel export.
 *
 * Re-exports every public symbol from the GPU sub-modules so
 * consumers can do `import { GPUCompute, ... } from '../gpu/index.js'`.
 *
 * @module gpu
 */

export { GPUCompute, createGPUCompute, createGPUWithFallback, outputSpec, uniform } from './gpu.js';
export { PipelineChain, DataPipelineChain } from './chains.js';
export { buildShader, BUILT_IN_OPS, BUILT_IN_OP_NAMES, SPECIAL_OPS } from './shaders.js';
export { runSpecial, runMatmul, buildMatmulShader, runReduce, getReduceBody,
  runHistogram, runArgMaxMin, runScan } from './special.js';
export { useGPU, useGPURun, useGPUMetrics, useGPUStatus } from './hooks.js';
export { createGPUBinder, createGPUSignalBinder, createGPUStoreBinder } from './adapters.js';
