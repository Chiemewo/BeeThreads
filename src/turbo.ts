/**
 * @fileoverview beeThreads.turbo - Parallel Array Processing
 * 
 * V8-OPTIMIZED: Raw for loops, monomorphic shapes, zero hidden class transitions
 * AUTOPACK: Automatic TypedArray serialization for object arrays (1.5-10x faster)
 * 
 * @example
 * ```typescript
 * // New syntax - array first, function in method
 * const squares = await beeThreads.turbo(numbers).map(x => x * x)
 * const evens = await beeThreads.turbo(numbers).filter(x => x % 2 === 0)
 * const sum = await beeThreads.turbo(numbers).reduce((a, b) => a + b, 0)
 * ```
 * 
 * @module bee-threads/turbo
 */

import { config } from './config';
import { requestWorker, releaseWorker, fastHash } from './pool';
import { canAutoPack } from './autopack';
import type { WorkerEntry, WorkerInfo } from './types';
import type { Worker } from 'worker_threads';

// ============================================================================
// CONSTANTS (V8: const for inline caching)
// ============================================================================

const TURBO_THRESHOLD = 10_000;
const MIN_ITEMS_PER_WORKER = 1_000;

/**
 * Minimum array size where AutoPack provides performance benefit.
 * Below this threshold, structuredClone overhead is acceptable.
 * Based on benchmarks: AutoPack wins at ~50+ objects.
 */
const AUTOPACK_THRESHOLD = 50;

// ============================================================================
// TYPES
// ============================================================================

export interface TurboOptions {
  /** Number of workers to use. Default: `os.cpus().length - 1` */
  workers?: number;
  /** Custom chunk size per worker. Default: auto-calculated */
  chunkSize?: number;
  /** Force parallel execution even for small arrays. Default: false */
  force?: boolean;
  /** Context variables to inject into worker function */
  context?: Record<string, unknown>;
  /** 
   * Enable/disable AutoPack serialization for object arrays.
   * - `'auto'` (default): Enable when array has 50+ objects with supported types
   * - `true`: Always use AutoPack (throws if data not compatible)
   * - `false`: Never use AutoPack, use structuredClone
   * 
   * AutoPack provides 1.5-10x faster serialization for arrays of objects
   * by converting to TypedArrays before postMessage transfer.
   */
  autoPack?: boolean | 'auto';
}

export interface TurboStats {
  /** Total number of items processed */
  totalItems: number;
  /** Number of workers used */
  workersUsed: number;
  /** Average items per worker */
  itemsPerWorker: number;
  /** True if SharedArrayBuffer was used (TypedArrays) */
  usedSharedMemory: boolean;
  /** True if AutoPack was used for serialization */
  usedAutoPack: boolean;
  /** Total execution time in milliseconds */
  executionTime: number;
  /** Estimated speedup ratio vs single-threaded */
  speedupRatio: string;
}

export interface TurboResult<T> {
  data: T[];
  stats: TurboStats;
}

// Monomorphic message shape - all properties declared upfront
interface TurboWorkerMessage {
  type: 'turbo_map' | 'turbo_reduce' | 'turbo_filter';
  fn: string;
  startIndex: number;
  endIndex: number;
  workerId: number;
  totalWorkers: number;
  context: Record<string, unknown> | undefined;
  inputBuffer: SharedArrayBuffer | undefined;
  outputBuffer: SharedArrayBuffer | undefined;
  controlBuffer: SharedArrayBuffer | undefined;
  chunk: unknown[] | undefined;
  initialValue: unknown | undefined;
}

// Monomorphic response shape
interface TurboWorkerResponse {
  type: 'turbo_complete' | 'turbo_error';
  workerId: number;
  result: unknown[] | undefined;
  error: { name: string; message: string; stack: string | undefined } | undefined;
  itemsProcessed: number;
}

// ============================================================================
// TYPED ARRAY DETECTION (V8: for loop, no .some())
// ============================================================================

const TYPED_ARRAY_CONSTRUCTORS = [
  Float64Array, Float32Array,
  Int32Array, Int16Array, Int8Array,
  Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray
];

type NumericTypedArray = 
  | Float64Array | Float32Array
  | Int32Array | Int16Array | Int8Array
  | Uint32Array | Uint16Array | Uint8Array | Uint8ClampedArray;

function isTypedArray(value: unknown): value is NumericTypedArray {
  if (value === null || typeof value !== 'object') return false;
  const len = TYPED_ARRAY_CONSTRUCTORS.length;
  for (let i = 0; i < len; i++) {
    if (value instanceof TYPED_ARRAY_CONSTRUCTORS[i]) return true;
  }
  return false;
}

/**
 * Determines if AutoPack should be used for the given data and options.
 * 
 * @param data - Array to check
 * @param options - Turbo options
 * @returns true if AutoPack should be used
 */
function shouldUseAutoPack(data: unknown[], options: TurboOptions): boolean {
  const autoPackOption = options.autoPack ?? 'auto';
  
  // Explicit disable
  if (autoPackOption === false) {
    return false;
  }
  
  // TypedArrays don't need AutoPack (already optimal with SharedArrayBuffer)
  if (isTypedArray(data)) {
    return false;
  }
  
  // Check if data is compatible with AutoPack
  const isCompatible = canAutoPack(data);
  
  // Explicit enable - throw if not compatible
  if (autoPackOption === true) {
    if (!isCompatible) {
      throw new TypeError(
        'AutoPack enabled but data is not compatible. ' +
        'AutoPack requires arrays of objects with primitive values (number, string, boolean). ' +
        'Set autoPack: false to use structuredClone instead.'
      );
    }
    return true;
  }
  
  // Auto mode - use if compatible AND above threshold
  if (autoPackOption === 'auto') {
    return isCompatible && data.length >= AUTOPACK_THRESHOLD;
  }
  
  return false;
}


// ============================================================================
// TURBO EXECUTOR - NEW SYNTAX: turbo(arr).map(fn)
// ============================================================================

export interface TurboExecutor<TItem> {
  /** Set the number of workers to use. Returns a new executor. */
  setWorkers(count: number): TurboExecutor<TItem>;
  map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]>;
  mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>>;
  filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]>;
  reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult>;
}

/**
 * Creates a TurboExecutor for parallel array processing.
 * 
 * @param data - Array or TypedArray to process
 * @param options - Turbo execution options
 * @returns TurboExecutor with map, filter, reduce methods
 * 
 * @example
 * ```typescript
 * const squares = await beeThreads.turbo(numbers).map(x => x * x)
 * const evens = await beeThreads.turbo(numbers).filter(x => x % 2 === 0)
 * const sum = await beeThreads.turbo(numbers).reduce((a, b) => a + b, 0)
 * ```
 */
export function createTurboExecutor<TItem>(
  data: TItem[] | NumericTypedArray,
  options: TurboOptions = {}
): TurboExecutor<TItem> {
  // V8: Monomorphic object shape - all methods declared upfront
  const executor: TurboExecutor<TItem> = {
    setWorkers(count: number): TurboExecutor<TItem> {
      if (!Number.isInteger(count) || count < 1) {
        throw new TypeError('setWorkers() requires a positive integer');
      }
      return createTurboExecutor<TItem>(data, { ...options, workers: count });
    },

    map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]> {
      const fnString = fn.toString();
      return executeTurboMap<TResult>(fnString, data as unknown[], options);
    },

    mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>> {
      const fnString = fn.toString();
      const startTime = Date.now();
      return executeTurboMapWithStats<TResult>(fnString, data as unknown[], options, startTime);
    },

    filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]> {
      const fnString = fn.toString();
      return executeTurboFilter<TItem>(fnString, data as unknown[], options);
    },

    reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult> {
      const fnString = fn.toString();
      return executeTurboReduce<TResult>(fnString, data as unknown[], initialValue, options);
    }
  };

  return executor;
}

// ============================================================================
// CORE EXECUTION - V8 OPTIMIZED
// ============================================================================

async function executeTurboMap<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions
): Promise<T[]> {
  const result = await executeTurboMapWithStats<T>(fnString, data, options, Date.now());
  return result.data;
}

async function executeTurboMapWithStats<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;
  const isTyped = isTypedArray(data);

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    return fallbackSingleExecution<T>(fnString, data, options, startTime);
  }

  // Calculate workers (V8: simple math, no method chains)
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const actualWorkers = numWorkers > 1 ? numWorkers : 1;
  const chunkSize = options.chunkSize !== undefined ? options.chunkSize : Math.ceil(dataLength / actualWorkers);

  // TypedArray path - SharedArrayBuffer
  if (isTyped) {
    return executeTurboTypedArray<T>(fnString, data as NumericTypedArray, actualWorkers, chunkSize, options, startTime);
  }

  // Regular array path
  return executeTurboRegularArray<T>(fnString, data, actualWorkers, chunkSize, options, startTime);
}

// ============================================================================
// TYPED ARRAY EXECUTION - SHARED MEMORY
// ============================================================================

async function executeTurboTypedArray<T>(
  fnString: string,
  data: NumericTypedArray,
  numWorkers: number,
  chunkSize: number,
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;

  // Create SharedArrayBuffers (V8: direct construction)
  const inputBuffer = new SharedArrayBuffer(dataLength * 8);
  const outputBuffer = new SharedArrayBuffer(dataLength * 8);
  const controlBuffer = new SharedArrayBuffer(4);

  // Copy input data (V8: raw for loop)
  const inputView = new Float64Array(inputBuffer);
  for (let i = 0; i < dataLength; i++) {
    inputView[i] = data[i];
  }

  const outputView = new Float64Array(outputBuffer);
  const controlView = new Int32Array(controlBuffer);
  Atomics.store(controlView, 0, 0);

  // Dispatch to workers (V8: pre-allocated array)
  const promises: Promise<void>[] = new Array(numWorkers);
  let workerCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const actualEnd = end < dataLength ? end : dataLength;

    if (start >= dataLength) break;

    // V8: Monomorphic message shape
    const message: TurboWorkerMessage = {
      type: 'turbo_map',
      fn: fnString,
      startIndex: start,
      endIndex: actualEnd,
      workerId: i,
      totalWorkers: numWorkers,
      context: options.context,
      inputBuffer: inputBuffer,
      outputBuffer: outputBuffer,
      controlBuffer: controlBuffer,
      chunk: undefined,
      initialValue: undefined
    };

    promises[i] = executeWorkerTurbo(fnString, message);
    workerCount++;
  }

  // Wait for completion (no slice - use length check)
  if (workerCount === numWorkers) {
    await Promise.all(promises);
  } else {
    // Only slice if we didn't fill the array
  await Promise.all(promises.slice(0, workerCount));
  }

  // Build result (V8: pre-allocated array)
  const result: T[] = new Array(dataLength);
  for (let i = 0; i < dataLength; i++) {
    result[i] = outputView[i] as unknown as T;
  }

  const executionTime = Date.now() - startTime;
  const estimatedSingle = executionTime * workerCount * 0.8;

  // V8: Monomorphic stats shape
  const stats: TurboStats = {
    totalItems: dataLength,
    workersUsed: workerCount,
    itemsPerWorker: Math.ceil(dataLength / workerCount),
    usedSharedMemory: true,
    usedAutoPack: false,
    executionTime: executionTime,
    speedupRatio: (estimatedSingle / executionTime).toFixed(1) + 'x'
  };

  return { data: result, stats: stats };
}

// ============================================================================
// REGULAR ARRAY EXECUTION - CHUNK BASED (OPTIMIZED + AUTOPACK)
// ============================================================================

async function executeTurboRegularArray<T>(
  fnString: string,
  data: unknown[],
  numWorkers: number,
  chunkSize: number,
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;
  const fnHash = fastHash(fnString);

  // Calculate chunk boundaries (V8: pre-allocated, no slice yet)
  const chunkBounds: Array<{ start: number; end: number }> = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // OPTIMIZATION 1: Batch worker acquisition - get all workers at once
  const workerRequests: Promise<WorkerInfo>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Fail-fast state
  let aborted = false;
  let firstError: Error | null = null;

  // OPTIMIZATION 2: Direct dispatch with pre-acquired workers
  const promises: Promise<T[]>[] = new Array(chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end); // Slice only when ready to send
    const { entry, worker, temporary } = workers[i];

    promises[i] = executeTurboChunkDirect<T>(
      fnString,
      fnHash,
      chunk,
      i,
      chunkCount,
      options.context,
      entry,
      worker,
      temporary,
      () => aborted
    ).catch((err: Error) => {
      if (!aborted) {
        aborted = true;
        firstError = err;
      }
      throw err;
    });
  }

  // Wait for all
  let chunkResults: T[][];
  try {
    chunkResults = await Promise.all(promises);
  } catch (err) {
    throw firstError !== null ? firstError : err;
  }

  // OPTIMIZATION 3: Merge with pre-calculated offsets
  let totalSize = 0;
  const offsets: number[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    offsets[i] = totalSize;
    totalSize += chunkResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  for (let i = 0; i < chunkCount; i++) {
    const chunkResult = chunkResults[i];
    const chunkLen = chunkResult.length;
    const offset = offsets[i];
    for (let j = 0; j < chunkLen; j++) {
      result[offset + j] = chunkResult[j];
    }
  }

  const executionTime = Date.now() - startTime;
  const estimatedSingle = executionTime * chunkCount * 0.7;

  // Determine if AutoPack was used (for stats)
  const usedAutoPack = shouldUseAutoPack(data, options);

  const stats: TurboStats = {
    totalItems: dataLength,
    workersUsed: chunkCount,
    itemsPerWorker: Math.ceil(dataLength / chunkCount),
    usedSharedMemory: false,
    usedAutoPack: usedAutoPack,
    executionTime: executionTime,
    speedupRatio: (estimatedSingle / executionTime).toFixed(1) + 'x'
  };

  return { data: result, stats: stats };
}

// ============================================================================
// FILTER EXECUTION (OPTIMIZED)
// ============================================================================

async function executeTurboFilter<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions
): Promise<T[]> {
  const dataLength = data.length;

  // Small array fallback (V8: inline function creation)
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    const result: T[] = [];
    for (let i = 0; i < dataLength; i++) {
      if (fn(data[i], i)) {
        result.push(data[i] as T);
      }
    }
    return result;
  }

  const fnHash = fastHash(fnString);
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const chunkSize = Math.ceil(dataLength / numWorkers);

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // OPTIMIZATION: Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Execute in parallel with pre-acquired workers
  const promises: Promise<unknown[]>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    promises[i] = executeFilterChunkDirect(fnString, fnHash, chunk, i, chunkCount, options.context, entry, worker, temporary);
  }

  const chunkResults = await Promise.all(promises);

  // Merge with pre-calculated offsets
  let totalSize = 0;
  const offsets: number[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    offsets[i] = totalSize;
    totalSize += chunkResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  for (let i = 0; i < chunkCount; i++) {
    const chunkResult = chunkResults[i];
    const chunkLen = chunkResult.length;
    const offset = offsets[i];
    for (let j = 0; j < chunkLen; j++) {
      result[offset + j] = chunkResult[j] as T;
    }
  }

  return result;
}

// ============================================================================
// REDUCE EXECUTION (OPTIMIZED)
// ============================================================================

async function executeTurboReduce<R>(
  fnString: string,
  data: unknown[],
  initialValue: R,
  options: TurboOptions
): Promise<R> {
  const dataLength = data.length;

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    let acc = initialValue;
    for (let i = 0; i < dataLength; i++) {
      acc = fn(acc, data[i], i);
    }
    return acc;
  }

  const fnHash = fastHash(fnString);
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const chunkSize = Math.ceil(dataLength / numWorkers);

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // OPTIMIZATION: Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Phase 1: Parallel reduction per chunk with pre-acquired workers
  const promises: Promise<R>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    promises[i] = executeReduceChunkDirect<R>(fnString, fnHash, chunk, initialValue, i, chunkCount, options.context, entry, worker, temporary);
  }

  const chunkResults = await Promise.all(promises);

  // Phase 2: Final reduction (V8: raw for loop)
  const fn = new Function('return ' + fnString)();
  let result = initialValue;
  for (let i = 0; i < chunkCount; i++) {
    result = fn(result, chunkResults[i]);
  }

  return result;
}

// ============================================================================
// WORKER HELPERS - V8 OPTIMIZED
// ============================================================================

async function executeWorkerTurbo(
  fnString: string,
  message: TurboWorkerMessage
): Promise<void> {
  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'high', fnHash);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      // V8: Direct property access, no nested ternary
      const msgType = msg.type;
      if (msgType === 'turbo_complete') {
        cleanup();
        resolve();
      } else if (msgType === 'turbo_error') {
        cleanup();
        const msgError = msg.error;
        const err = new Error(msgError !== undefined ? msgError.message : 'Turbo worker error');
        err.name = msgError !== undefined ? msgError.name : 'TurboError';
        reject(err);
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(message);
  });
}

// OPTIMIZED: Uses pre-acquired worker - no await inside
function executeTurboChunkDirect<T>(
  fnString: string,
  fnHash: string,
  chunk: unknown[],
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  entry: WorkerEntry,
  worker: Worker,
  temporary: boolean,
  shouldAbort: () => boolean
): Promise<T[]> {
  if (shouldAbort()) {
    // Release the pre-acquired worker before throwing
    releaseWorker(entry, worker, temporary, 'normal', 0, false, fnHash);
    return Promise.reject(new Error('Turbo execution aborted'));
  }

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (shouldAbort() && !settled) {
        cleanup();
        reject(new Error('Turbo execution aborted'));
        return;
      }

      if (msg.type === 'turbo_complete') {
        cleanup();
        resolve(msg.result as T[]);
      } else if (msg.type === 'turbo_error') {
        cleanup();
        const err = new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error');
        err.name = msg.error !== undefined ? msg.error.name : 'TurboWorkerError';
        reject(err);
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    // V8: Monomorphic message
    const message: TurboWorkerMessage = {
      type: 'turbo_map',
      fn: fnString,
      startIndex: 0,
      endIndex: 0,
      workerId: workerId,
      totalWorkers: totalWorkers,
      context: context,
      inputBuffer: undefined,
      outputBuffer: undefined,
      controlBuffer: undefined,
      chunk: chunk,
      initialValue: undefined
    };

    worker.postMessage(message);
  });
}

// OPTIMIZED: Uses pre-acquired worker for filter
function executeFilterChunkDirect(
  fnString: string,
  fnHash: string,
  chunk: unknown[],
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  entry: WorkerEntry,
  worker: Worker,
  temporary: boolean
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        resolve(msg.result !== undefined ? msg.result : []);
      } else if (msg.type === 'turbo_error') {
        cleanup();
        reject(new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    worker.postMessage({
      type: 'turbo_filter',
      fn: fnString,
      chunk: chunk,
      workerId: workerId,
      totalWorkers: totalWorkers,
      context: context
    });
  });
}

// OPTIMIZED: Uses pre-acquired worker for reduce
function executeReduceChunkDirect<R>(
  fnString: string,
  fnHash: string,
  chunk: unknown[],
  initialValue: R,
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  entry: WorkerEntry,
  worker: Worker,
  temporary: boolean
): Promise<R> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        const result = msg.result;
        resolve(result !== undefined && result.length > 0 ? result[0] as R : initialValue);
      } else if (msg.type === 'turbo_error') {
        cleanup();
        reject(new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    worker.postMessage({
      type: 'turbo_reduce',
      fn: fnString,
      chunk: chunk,
      initialValue: initialValue,
      workerId: workerId,
      totalWorkers: totalWorkers,
      context: context
    });
  });
}

// ============================================================================
// FALLBACK - SINGLE WORKER
// ============================================================================

async function fallbackSingleExecution<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'normal', fnHash);
  const dataLength = data.length;

  return new Promise((resolve, reject) => {
    const execStart = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - execStart, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        const executionTime = Date.now() - startTime;
        const stats: TurboStats = {
          totalItems: dataLength,
          workersUsed: 1,
          itemsPerWorker: dataLength,
          usedSharedMemory: false,
          usedAutoPack: false,
          executionTime: executionTime,
          speedupRatio: '1.0x'
        };
        resolve({ data: msg.result as T[], stats: stats });
      } else if (msg.type === 'turbo_error') {
        cleanup();
        reject(new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    const chunk = isTypedArray(data) ? Array.from(data) : data;
    worker.postMessage({
      type: 'turbo_map',
      fn: fnString,
      chunk: chunk,
      workerId: 0,
      totalWorkers: 1,
      context: options.context
    });
  });
}

// ============================================================================
// MAX MODE - TURBO + MAIN THREAD PROCESSING
// ============================================================================

/**
 * Compiles function with context injection for main thread execution.
 * Same logic as workers use - wraps function with context variables.
 */
function compileWithContext(fnString: string, context?: Record<string, unknown>): Function {
  if (!context || Object.keys(context).length === 0) {
    // No context - direct compilation
    return new Function('return ' + fnString)();
  }
  
  // With context - inject variables
  const contextKeys = Object.keys(context);
  const contextValues = contextKeys.map(k => context[k]);
  
  // Create wrapper function that receives context values as params
  const wrapperCode = `
    return function(${contextKeys.join(', ')}) {
      const fn = ${fnString};
      return fn;
    }
  `;
  
  const wrapper = new Function(wrapperCode)();
  return wrapper(...contextValues);
}

export interface MaxOptions extends TurboOptions {
  // No additional options needed - uses same as turbo
}

/**
 * @experimental
 * Creates a TurboExecutor that includes the main thread in processing.
 * Uses ALL available CPU cores including the main thread.
 * 
 * WARNING: Blocks the main thread during processing. Use only when:
 * - You need 100% CPU utilization
 * - No HTTP requests/events need to be handled
 * - The workload is pure computation
 * 
 * @param data - Array or TypedArray to process
 * @param options - Max execution options
 * @returns TurboExecutor with map, filter, reduce methods
 * 
 * @example
 * ```typescript
 * // Max throughput - uses all cores including main thread
 * const result = await beeThreads.max(hugeArray).map(x => heavyComputation(x))
 * ```
 */
export function createMaxExecutor<TItem>(
  data: TItem[] | NumericTypedArray,
  options: MaxOptions = {}
): TurboExecutor<TItem> {
  // V8: Monomorphic object shape
  const executor: TurboExecutor<TItem> = {
    setWorkers(count: number): TurboExecutor<TItem> {
      if (!Number.isInteger(count) || count < 1) {
        throw new TypeError('setWorkers() requires a positive integer');
      }
      return createMaxExecutor<TItem>(data, { ...options, workers: count });
    },

    map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]> {
      const fnString = fn.toString();
      return executeMaxMap<TResult>(fnString, data as unknown[], options);
    },

    mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>> {
      const fnString = fn.toString();
      const startTime = Date.now();
      return executeMaxMapWithStats<TResult>(fnString, data as unknown[], options, startTime);
    },

    filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]> {
      const fnString = fn.toString();
      return executeMaxFilter<TItem>(fnString, data as unknown[], options);
    },

    reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult> {
      const fnString = fn.toString();
      return executeMaxReduce<TResult>(fnString, data as unknown[], initialValue, options);
    }
  };

  return executor;
}

// ============================================================================
// MAX EXECUTION - TURBO + MAIN THREAD
// ============================================================================

async function executeMaxMap<T>(
  fnString: string,
  data: unknown[],
  options: MaxOptions
): Promise<T[]> {
  const result = await executeMaxMapWithStats<T>(fnString, data, options, Date.now());
  return result.data;
}

async function executeMaxMapWithStats<T>(
  fnString: string,
  data: unknown[],
  options: MaxOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    return fallbackSingleExecution<T>(fnString, data, options, startTime);
  }

  // Calculate workers + main thread
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const actualWorkers = numWorkers > 1 ? numWorkers : 1;
  
  // Main thread gets a chunk too
  const totalThreads = actualWorkers + 1;
  const chunkSize = options.chunkSize !== undefined ? options.chunkSize : Math.ceil(dataLength / totalThreads);

  const fnHash = fastHash(fnString);

  // Calculate chunk boundaries for workers + main thread
  const chunkBounds: Array<{ start: number; end: number }> = new Array(totalThreads);
  let chunkCount = 0;

  for (let i = 0; i < totalThreads; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // Last chunk is for main thread
  const mainThreadChunkIndex = chunkCount - 1;
  const workerChunks = chunkCount - 1;

  // Batch worker acquisition (parallel)
  const workerRequests: Promise<WorkerInfo>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }

  // Start worker dispatches and main thread processing in parallel
  const workers = await Promise.all(workerRequests);

  // Dispatch to workers
  const workerPromises: Promise<T[]>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];

    workerPromises[i] = executeTurboChunkDirect<T>(
      fnString,
      fnHash,
      chunk,
      i,
      chunkCount,
      options.context,
      entry,
      worker,
      temporary,
      () => false
    );
  }

  // Main thread processes its chunk while workers run
  const mainChunk = chunkBounds[mainThreadChunkIndex];
  const mainChunkData = data.slice(mainChunk.start, mainChunk.end);
  
  // Compile function with context support
  const fn = compileWithContext(fnString, options.context);
  
  // Process main thread chunk
  const mainResult: T[] = new Array(mainChunkData.length);
  for (let i = 0; i < mainChunkData.length; i++) {
    mainResult[i] = fn(mainChunkData[i], mainChunk.start + i);
  }

  // Wait for all workers
  const workerResults = await Promise.all(workerPromises);

  // Merge results with pre-calculated offsets
  let totalSize = 0;
  const offsets: number[] = new Array(chunkCount);
  
  for (let i = 0; i < workerChunks; i++) {
    offsets[i] = totalSize;
    totalSize += workerResults[i].length;
  }
  offsets[mainThreadChunkIndex] = totalSize;
  totalSize += mainResult.length;

  const result: T[] = new Array(totalSize);
  
  // Copy worker results
  for (let i = 0; i < workerChunks; i++) {
    const chunkResult = workerResults[i];
    const chunkLen = chunkResult.length;
    const offset = offsets[i];
    for (let j = 0; j < chunkLen; j++) {
      result[offset + j] = chunkResult[j];
    }
  }
  
  // Copy main thread result
  const offset = offsets[mainThreadChunkIndex];
  for (let j = 0; j < mainResult.length; j++) {
    result[offset + j] = mainResult[j];
  }

  const executionTime = Date.now() - startTime;
  const estimatedSingle = executionTime * chunkCount * 0.7;

  const stats: TurboStats = {
    totalItems: dataLength,
    workersUsed: chunkCount,
    itemsPerWorker: Math.ceil(dataLength / chunkCount),
    usedSharedMemory: false,
    usedAutoPack: false,
    executionTime: executionTime,
    speedupRatio: (estimatedSingle / executionTime).toFixed(1) + 'x'
  };

  return { data: result, stats: stats };
}

async function executeMaxFilter<T>(
  fnString: string,
  data: unknown[],
  options: MaxOptions
): Promise<T[]> {
  const dataLength = data.length;

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    const result: T[] = [];
    for (let i = 0; i < dataLength; i++) {
      if (fn(data[i], i)) {
        result.push(data[i] as T);
      }
    }
    return result;
  }

  const fnHash = fastHash(fnString);
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  
  // Main thread + workers
  const totalThreads = numWorkers + 1;
  const chunkSize = Math.ceil(dataLength / totalThreads);

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(totalThreads);
  let chunkCount = 0;

  for (let i = 0; i < totalThreads; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  const mainThreadChunkIndex = chunkCount - 1;
  const workerChunks = chunkCount - 1;

  // Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Execute in parallel with pre-acquired workers
  const workerPromises: Promise<unknown[]>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    workerPromises[i] = executeFilterChunkDirect(fnString, fnHash, chunk, i, chunkCount, options.context, entry, worker, temporary);
  }

  // Main thread filter
  const mainChunk = chunkBounds[mainThreadChunkIndex];
  const fn = compileWithContext(fnString, options.context);
  const mainResult: T[] = [];
  for (let i = mainChunk.start; i < mainChunk.end; i++) {
    if (fn(data[i], i)) {
      mainResult.push(data[i] as T);
    }
  }

  const workerResults = await Promise.all(workerPromises);

  // Merge with pre-calculated offsets
  let totalSize = mainResult.length;
  for (let i = 0; i < workerChunks; i++) {
    totalSize += workerResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  let offset = 0;
  
  // Copy worker results first
  for (let i = 0; i < workerChunks; i++) {
    const chunkResult = workerResults[i];
    const chunkLen = chunkResult.length;
    for (let j = 0; j < chunkLen; j++) {
      result[offset++] = chunkResult[j] as T;
    }
  }
  
  // Copy main result
  for (let j = 0; j < mainResult.length; j++) {
    result[offset++] = mainResult[j];
  }

  return result;
}

async function executeMaxReduce<R>(
  fnString: string,
  data: unknown[],
  initialValue: R,
  options: MaxOptions
): Promise<R> {
  const dataLength = data.length;

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    let acc = initialValue;
    for (let i = 0; i < dataLength; i++) {
      acc = fn(acc, data[i], i);
    }
    return acc;
  }

  const fnHash = fastHash(fnString);
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  
  // Main thread + workers
  const totalThreads = numWorkers + 1;
  const chunkSize = Math.ceil(dataLength / totalThreads);

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(totalThreads);
  let chunkCount = 0;

  for (let i = 0; i < totalThreads; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  const mainThreadChunkIndex = chunkCount - 1;
  const workerChunks = chunkCount - 1;

  // Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Phase 1: Parallel reduction per chunk with pre-acquired workers
  const workerPromises: Promise<R>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    workerPromises[i] = executeReduceChunkDirect<R>(fnString, fnHash, chunk, initialValue, i, chunkCount, options.context, entry, worker, temporary);
  }

  // Main thread reduce
  const mainChunk = chunkBounds[mainThreadChunkIndex];
  const fn = compileWithContext(fnString, options.context);
  let mainAcc = initialValue;
  for (let i = mainChunk.start; i < mainChunk.end; i++) {
    mainAcc = fn(mainAcc, data[i], i);
  }

  const workerResults = await Promise.all(workerPromises);

  // Phase 2: Final reduction (combine all partial results)
  let result = initialValue;
  for (let i = 0; i < workerChunks; i++) {
    result = fn(result, workerResults[i]);
  }
  result = fn(result, mainAcc);

  return result;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { TURBO_THRESHOLD, MIN_ITEMS_PER_WORKER };
