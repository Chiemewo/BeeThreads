/**
 * @fileoverview Worker pool management for bee-threads.
 *
 * Manages the lifecycle of worker threads:
 * - Creating workers with proper configuration
 * - Selecting the best worker for a task (load balancing + affinity)
 * - Returning workers to the pool after use
 * - Cleaning up idle workers to free resources
 * - Managing temporary overflow workers
 * - Counter management (busy/idle) with race-condition protection
 *
 * Selection Strategy (priority order):
 * 1. Affinity match - worker already has function cached
 * 2. Least-used idle - distributes load evenly
 * 3. Create new pooled - pool not at capacity
 * 4. Create temporary - overflow handling
 * 5. Queue task - no resources available
 *
 * ## V8 Optimizations
 *
 * - Monomorphic return shapes (stable object structure)
 * - Raw for loops instead of .find()/.filter()
 * - O(1) counter checks before array iteration
 * - Pre-allocated arrays where possible
 *
 * @module bee-threads/pool
 * @internal
 */

import { Worker } from 'worker_threads';
import { SCRIPTS, config, pools, poolCounters, queues, metrics } from './config';
import { QueueFullError } from './errors';
import type {
  PoolType,
  Priority,
  WorkerEntry,
  WorkerInfo,
  QueuedTask,
  PriorityQueues
} from './types';

// ============================================================================
// EXTENDED WORKER TYPE
// ============================================================================

interface TemporaryWorker extends Worker {
  _temporary?: boolean;
  _startTime?: number;
}

/** Worker ID counter - faster than Date.now() + Math.random() */
let workerIdCounter = 0;

// ============================================================================
// FUNCTION AFFINITY TRACKING
// ============================================================================

// Re-export fastHash from cache.ts for backwards compatibility
export { fastHash } from './cache';

// ============================================================================
// WORKER CREATION
// ============================================================================

/**
 * Creates a new worker with tracking metadata.
 * 
 * V8 Optimizations:
 * - WorkerEntry has stable shape (all properties initialized)
 * - Worker options object created with consistent shape
 */
export function createWorkerEntry(script: string, poolType: PoolType): WorkerEntry {
  const cacheSize = config.lowMemoryMode ? 10 : config.functionCacheSize;

  // V8: Monomorphic object - all properties declared
  const workerOptions: {
    workerData: { 
      functionCacheSize: number; 
      lowMemoryMode: boolean; 
      debugMode: boolean;
    };
    resourceLimits?: typeof config.resourceLimits;
  } = {
    workerData: {
      functionCacheSize: cacheSize,
      lowMemoryMode: config.lowMemoryMode,
      debugMode: config.debugMode
    }
  };

  if (config.resourceLimits) {
    workerOptions.resourceLimits = config.resourceLimits;
  }

  const worker = new Worker(script, workerOptions);

  // Don't block process exit
  worker.unref();
  
  // Prevent MaxListenersExceededWarning when many tasks use same worker
  worker.setMaxListeners(0);

  // V8: Monomorphic entry shape - all properties initialized upfront
  // Use counter for ID (faster than Date.now() + Math.random())
  const entry: WorkerEntry = {
    worker: worker,
    busy: false,
    id: ++workerIdCounter,
    tasksExecuted: 0,
    totalExecutionTime: 0,
    failedTasks: 0,
    temporary: false,
    terminationTimer: null,
    cachedFunctions: new Set<string>()
  };

  // Auto-remove from pool on worker exit
  worker.on('exit', () => {
    const pool = pools[poolType];
    const poolLen = pool.length;
    let idx = -1;
    // V8: Raw for loop for indexOf
    for (let i = 0; i < poolLen; i++) {
      if (pool[i] === entry) {
        idx = i;
        break;
      }
    }
    if (idx !== -1) {
      pool.splice(idx, 1);
      if (entry.busy) {
        poolCounters[poolType].busy--;
      } else {
        poolCounters[poolType].idle--;
      }
    }
  });

  poolCounters[poolType].idle++;
  return entry;
}

/**
 * Schedules automatic termination of idle workers.
 */
export function scheduleIdleTimeout(entry: WorkerEntry, poolType: PoolType): void {
  if (config.workerIdleTimeout <= 0) return;

  if (entry.terminationTimer) {
    clearTimeout(entry.terminationTimer);
  }

  entry.terminationTimer = setTimeout(() => {
    const pool = pools[poolType];
    const minToKeep = config.minThreads > 1 ? config.minThreads : 1;
    if (!entry.busy && pool.length > minToKeep) {
      entry.worker.terminate();
    }
  }, config.workerIdleTimeout);
}

/**
 * Pre-creates workers to have them ready before tasks arrive.
 */
export async function warmupPool(poolType: PoolType, count: number): Promise<void> {
  const pool = pools[poolType];
  const script = SCRIPTS[poolType];
  const poolSizeLimit = config.poolSize < count ? config.poolSize : count;
  const toCreate = poolSizeLimit - pool.length;

  // V8: Raw for loop
  for (let i = 0; i < toCreate; i++) {
    const entry = createWorkerEntry(script, poolType);
    pool.push(entry);
  }
}

// ============================================================================
// WORKER ACQUISITION
// ============================================================================

/**
 * Result of getWorker operation.
 * V8: Monomorphic shape - all properties always present.
 */
interface GetWorkerResult {
  entry: WorkerEntry | null;
  worker: Worker;
  temporary: boolean;
  affinityHit: boolean;
}

/**
 * Gets an available worker using affinity-aware load balancing.
 * 
 * V8 Optimizations:
 * - Returns monomorphic object shape
 * - Uses raw for loops
 * - O(1) counter checks before iteration
 */
export function getWorker(poolType: PoolType, fnHash: string | null = null): GetWorkerResult | null {
  const pool = pools[poolType];
  const script = SCRIPTS[poolType];
  const counters = poolCounters[poolType];
  const poolLen = pool.length;

  // Strategy 1: Find idle worker with affinity match
  if (fnHash && counters.idle > 0) {
    for (let i = 0; i < poolLen; i++) {
      const entry = pool[i];
      if (!entry.busy && entry.cachedFunctions.has(fnHash)) {
        entry.busy = true;
        counters.busy++;
        counters.idle--;
        if (entry.terminationTimer) {
          clearTimeout(entry.terminationTimer);
          entry.terminationTimer = null;
        }
        metrics.affinityHits++;
        // V8: Monomorphic return shape - always same properties
        return { entry: entry, worker: entry.worker, temporary: false, affinityHit: true };
      }
    }
    metrics.affinityMisses++;
  }

  // Strategy 2: Find idle worker with fewest tasks
  if (counters.idle > 0) {
    let selected: WorkerEntry | null = null;
    let minTasks = Infinity;

    for (let i = 0; i < poolLen; i++) {
      const entry = pool[i];
      if (!entry.busy) {
        // Fresh worker - use immediately
        if (entry.tasksExecuted === 0) {
          selected = entry;
          break;
        }
        if (entry.tasksExecuted < minTasks) {
          minTasks = entry.tasksExecuted;
          selected = entry;
        }
      }
    }

    if (selected) {
      selected.busy = true;
      counters.busy++;
      counters.idle--;
      if (selected.terminationTimer) {
        clearTimeout(selected.terminationTimer);
        selected.terminationTimer = null;
      }
      // V8: Monomorphic return shape
      return { entry: selected, worker: selected.worker, temporary: false, affinityHit: false };
    }
  }

  // Strategy 3: Create new pooled worker
  if (poolLen < config.poolSize) {
    const entry = createWorkerEntry(script, poolType);
    entry.busy = true;
    // Adjust counter - new worker starts busy, not idle
    counters.idle--;
    counters.busy++;
    pool.push(entry);
    // V8: Monomorphic return shape
    return { entry: entry, worker: entry.worker, temporary: false, affinityHit: false };
  }

  // Strategy 4: Create temporary worker
  if (metrics.activeTemporaryWorkers < config.maxTemporaryWorkers) {
    // V8: Monomorphic workerOptions shape
    const workerOptions: {
      workerData: { 
        functionCacheSize: number; 
        lowMemoryMode: boolean; 
        debugMode: boolean;
      };
      resourceLimits?: typeof config.resourceLimits;
    } = {
      workerData: { 
        functionCacheSize: config.functionCacheSize,
        lowMemoryMode: config.lowMemoryMode,
        debugMode: config.debugMode
      }
    };
    if (config.resourceLimits) {
      workerOptions.resourceLimits = config.resourceLimits;
    }
    const tempWorker: TemporaryWorker = new Worker(script, workerOptions);

    tempWorker.unref();
    tempWorker.setMaxListeners(0);
    tempWorker._temporary = true;
    tempWorker._startTime = Date.now();
    metrics.temporaryWorkersCreated++;
    metrics.activeTemporaryWorkers++;
    // V8: Monomorphic return shape
    return { entry: null, worker: tempWorker, temporary: true, affinityHit: false };
  }

  // Must queue
  return null;
}

/**
 * Returns a worker to the pool after task completion.
 * 
 * @param terminated - If true, the worker was forcefully terminated (timeout/abort)
 *                     and should be removed from pool instead of returned
 */
export function releaseWorker(
  entry: WorkerEntry | null,
  worker: Worker,
  temporary: boolean,
  poolType: PoolType,
  executionTime: number = 0,
  failed: boolean = false,
  fnHash: string | null = null,
  terminated: boolean = false
): void {
  if (temporary) {
    metrics.activeTemporaryWorkers--;
    metrics.temporaryWorkerTasks++;
    metrics.temporaryWorkerExecutionTime += executionTime;
    // Only terminate if not already terminated
    if (!terminated) {
      worker.terminate();
    }
    return;
  }

  if (!entry) return;

  const counters = poolCounters[poolType];
  const pool = pools[poolType];

  // Update stats
  entry.tasksExecuted++;
  entry.totalExecutionTime += executionTime;
  if (failed) entry.failedTasks++;

  // If worker was forcefully terminated, remove from pool
  if (terminated) {
    if (entry.terminationTimer) {
      clearTimeout(entry.terminationTimer);
      entry.terminationTimer = null;
    }
    // V8: Raw for loop for indexOf
    const poolLen = pool.length;
    let idx = -1;
    for (let i = 0; i < poolLen; i++) {
      if (pool[i] === entry) {
        idx = i;
        break;
      }
    }
    if (idx !== -1) {
      pool.splice(idx, 1);
      if (entry.busy) {
        counters.busy--;
      } else {
        counters.idle--;
      }
    }
    return;
  }

  // Track function for affinity
  if (fnHash && !config.lowMemoryMode) {
    if (entry.cachedFunctions.size >= 50) {
      entry.cachedFunctions.clear();
    }
    entry.cachedFunctions.add(fnHash);
  }

  // Check for queued tasks
  const queue = queues[poolType];
  const nextTask = dequeueTask(queue);
  if (nextTask && entry.busy) {
    if (entry.terminationTimer) {
      clearTimeout(entry.terminationTimer);
      entry.terminationTimer = null;
    }
    nextTask.resolve({ entry: entry, worker: entry.worker, temporary: false });
  } else if (entry.busy) {
    // Only update counters if worker was actually busy
    entry.busy = false;
    counters.busy--;
    counters.idle++;
    scheduleIdleTimeout(entry, poolType);
  }
}

// ============================================================================
// QUEUE MANAGEMENT
// ============================================================================

/**
 * Gets total queue length across all priorities.
 */
export function getQueueLength(queue: PriorityQueues): number {
  return queue.high.length + queue.normal.length + queue.low.length;
}

/**
 * Dequeues the highest priority task.
 */
export function dequeueTask(queue: PriorityQueues): QueuedTask | null {
  if (queue.high.length > 0) return queue.high.shift()!;
  if (queue.normal.length > 0) return queue.normal.shift()!;
  if (queue.low.length > 0) return queue.low.shift()!;
  return null;
}

/**
 * Requests a worker, queueing if none available.
 */
export function requestWorker(
  poolType: PoolType,
  priority: Priority = 'normal',
  fnHash: string | null = null
): Promise<WorkerInfo> {
  const result = getWorker(poolType, fnHash);
  if (result) {
    return Promise.resolve({
      worker: result.worker,
      entry: result.entry!,
      temporary: result.temporary
    });
  }

  const queue = queues[poolType];
  if (getQueueLength(queue) >= config.maxQueueSize) {
    return Promise.reject(new QueueFullError(config.maxQueueSize));
  }

  // O(1) priority validation
  const queuePriority = (priority === 'high' || priority === 'normal' || priority === 'low') ? priority : 'normal';

  return new Promise((resolve, reject) => {
    // V8: Monomorphic task shape
    const task: QueuedTask = {
      fnString: '',
      args: [],
      context: null,
      transfer: [],
      resolve: (info: WorkerInfo) => resolve(info),
      reject: reject,
      priority: queuePriority
    };
    queue[queuePriority].push(task);
  });
}
