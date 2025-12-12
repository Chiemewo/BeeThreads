/**
 * @fileoverview File-based worker execution for bee-threads.
 * 
 * Allows running worker files with full access to require/imports.
 * Type-safe API with generic function inference.
 * Supports turbo mode for parallel array processing.
 * 
 * @example
 * ```typescript
 * // workers/process-user.ts
 * import { db } from '../database';
 * export default async function(user: User): Promise<ProcessedUser> {
 *   return { ...user, score: await db.getScore(user.id) };
 * }
 * 
 * // main.ts - Single call
 * import type processUser from './workers/process-user';
 * const result = await beeThreads.worker<typeof processUser>('./workers/process-user')(user);
 * 
 * // main.ts - Turbo mode (parallel array processing)
 * const results = await beeThreads.worker('./workers/process-user').turbo(users);
 * ```
 * 
 * @module bee-threads/file-worker
 * @internal
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// TYPES
// ============================================================================

type AnyFunction = (...args: any[]) => any;

interface FileWorkerEntry {
  worker: Worker;
  busy: boolean;
  path: string;
}

export interface TurboWorkerOptions {
  /** Number of workers to use (default: cpus - 1) */
  workers?: number;
}

export interface FileWorkerExecutor<T extends AnyFunction> {
  /** Execute worker with arguments */
  (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>;
  
  /** 
   * Turbo mode - process array in parallel across multiple workers.
   * Worker receives chunks and should return processed chunks.
   * 
   * @example
   * ```typescript
   * // Worker must accept array and return array
   * // workers/process-chunk.js
   * module.exports = async (items) => items.map(x => x * 2);
   * 
   * // main.ts
   * const results = await beeThreads.worker('./workers/process-chunk.js')
   *   .turbo([1,2,3,4,5,6,7,8], { workers: 4 });
   * // → [2,4,6,8,10,12,14,16]
   * ```
   */
  turbo<TItem>(
    data: TItem[],
    options?: TurboWorkerOptions
  ): Promise<TItem[]>;
}

// ============================================================================
// WORKER POOL (per file)
// ============================================================================

const workerPools = new Map<string, FileWorkerEntry[]>();
const DEFAULT_MAX_WORKERS = Math.max(2, os.cpus().length - 1);

/**
 * Resolves and normalizes file path.
 */
function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

/**
 * Creates a new worker for the given file path.
 */
function createWorker(absPath: string): Worker {
  const workerCode = `
    const { parentPort } = require('worker_threads');
    const fn = require('${absPath.replace(/\\/g, '\\\\')}');
    const handler = fn.default || fn;
    
    parentPort.on('message', async ({ id, args, isTurboChunk }) => {
      try {
        let result;
        if (isTurboChunk) {
          // Turbo mode: process array chunk
          result = await handler(args[0]);
        } else {
          // Normal mode: call with spread args
          result = await handler(...args);
        }
        parentPort.postMessage({ id, success: true, result });
      } catch (error) {
        parentPort.postMessage({ 
          id, 
          success: false, 
          error: { 
            message: error.message, 
            name: error.name,
            stack: error.stack 
          }
        });
      }
    });
  `;
  
  return new Worker(workerCode, { eval: true });
}

/**
 * Gets or creates workers for turbo mode.
 */
function getWorkersForTurbo(filePath: string, count: number): FileWorkerEntry[] {
  const absPath = resolvePath(filePath);
  
  let pool = workerPools.get(absPath);
  if (!pool) {
    pool = [];
    workerPools.set(absPath, pool);
  }
  
  // Ensure we have enough workers
  while (pool.length < count) {
    const worker = createWorker(absPath);
    pool.push({ worker, busy: false, path: absPath });
  }
  
  return pool.slice(0, count);
}

/**
 * Gets or creates a single worker.
 */
function getWorker(filePath: string): FileWorkerEntry {
  const absPath = resolvePath(filePath);
  
  let pool = workerPools.get(absPath);
  if (!pool) {
    pool = [];
    workerPools.set(absPath, pool);
  }
  
  // Find idle worker
  const idle = pool.find(w => !w.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  
  // Create new worker if under default limit
  if (pool.length < DEFAULT_MAX_WORKERS) {
    const worker = createWorker(absPath);
    const entry: FileWorkerEntry = { worker, busy: true, path: absPath };
    pool.push(entry);
    return entry;
  }
  
  // All workers busy, use first (will queue)
  const first = pool[0];
  first.busy = true;
  return first;
}

/**
 * Releases a worker back to the pool.
 */
function releaseWorker(entry: FileWorkerEntry): void {
  entry.busy = false;
}

// ============================================================================
// EXECUTION
// ============================================================================

let messageId = 0;

/**
 * Executes a single call on a worker.
 */
function executeOnWorker<T>(
  entry: FileWorkerEntry,
  args: unknown[],
  isTurboChunk: boolean = false
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    
    const handler = (msg: { id: number; success: boolean; result?: any; error?: any }) => {
      if (msg.id !== id) return;
      
      entry.worker.off('message', handler);
      releaseWorker(entry);
      
      if (msg.success) {
        resolve(msg.result);
      } else {
        const error = new Error(msg.error?.message || 'Worker error');
        error.name = msg.error?.name || 'WorkerError';
        if (msg.error?.stack) error.stack = msg.error.stack;
        reject(error);
      }
    };
    
    entry.worker.on('message', handler);
    entry.worker.postMessage({ id, args, isTurboChunk });
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Creates a type-safe file worker executor with turbo support.
 * 
 * @param filePath - Path to the worker file (must export default function)
 * @returns Executor with call and turbo methods
 * 
 * @example
 * ```typescript
 * // Single execution
 * const result = await beeThreads.worker('./worker.js')(arg1, arg2);
 * 
 * // Turbo mode (parallel array processing)
 * const results = await beeThreads.worker('./worker.js').turbo(bigArray, { workers: 8 });
 * ```
 */
export function createFileWorker<T extends AnyFunction>(
  filePath: string
): FileWorkerExecutor<T> {
  const absPath = resolvePath(filePath);
  
  // Create callable function
  const executor = ((...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    const entry = getWorker(absPath);
    return executeOnWorker(entry, args, false);
  }) as FileWorkerExecutor<T>;
  
  // Add turbo method
  executor.turbo = async <TItem>(
    data: TItem[],
    options: TurboWorkerOptions = {}
  ): Promise<TItem[]> => {
    const numWorkers = options.workers ?? DEFAULT_MAX_WORKERS;
    const dataLength = data.length;
    
    // Small array optimization
    if (dataLength <= numWorkers) {
      const entry = getWorker(absPath);
      return executeOnWorker(entry, [data], true);
    }
    
    // Get workers
    const workers = getWorkersForTurbo(absPath, numWorkers);
    const chunkSize = Math.ceil(dataLength / numWorkers);
    
    // Create chunks and execute in parallel
    const promises: Promise<TItem[]>[] = [];
    
    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, dataLength);
      
      if (start >= dataLength) break;
      
      const chunk = data.slice(start, end);
      const entry = workers[i];
      entry.busy = true;
      
      promises.push(executeOnWorker<TItem[]>(entry, [chunk], true));
    }
    
    // Wait for all and merge results
    const results = await Promise.all(promises);
    
    // Flatten results maintaining order
    const merged: TItem[] = [];
    for (const chunk of results) {
      for (const item of chunk) {
        merged.push(item);
      }
    }
    
    return merged;
  };
  
  return executor;
}

/**
 * Terminates all file workers.
 */
export async function terminateFileWorkers(): Promise<void> {
  const promises: Promise<number>[] = [];
  
  for (const pool of workerPools.values()) {
    for (const entry of pool) {
      promises.push(entry.worker.terminate());
    }
  }
  
  await Promise.all(promises);
  workerPools.clear();
}
