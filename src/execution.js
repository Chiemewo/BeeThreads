/**
 * @fileoverview Core execution engine for bee-threads.
 * 
 * ## What This File Does
 * 
 * This is the heart of task execution. It orchestrates:
 * 1. Acquiring a worker from the pool (with affinity preference)
 * 2. Sending the task to the worker
 * 3. Handling responses, errors, and timeouts
 * 4. Releasing the worker back to the pool
 * 5. Tracking metrics for monitoring
 * 
 * ## Why Separated from pool.js
 * 
 * - **Single responsibility**: Pool manages workers, execution manages tasks
 * - **Testability**: Can mock pool interactions
 * - **Clarity**: Execution logic doesn't mix with pool lifecycle
 * 
 * ## Execution Flow
 * 
 * ```
 * execute() → Check abort → Request worker → Send task
 *                                              ↓
 *                                          Worker runs
 *                                              ↓
 *                                          Response
 *                                              ↓
 *           Cleanup ← Release worker ← Update metrics
 * ```
 * 
 * ## Retry Behavior
 * 
 * - AbortError and TimeoutError are NEVER retried (intentional failures)
 * - Other errors trigger retry with exponential backoff + jitter
 * - Backoff prevents thundering herd on mass failures
 * 
 * @module bee-threads/execution
 */

'use strict';

const { config, metrics } = require('./config');
const { requestWorker, releaseWorker, fastHash } = require('./pool');
const { sleep, calculateBackoff } = require('./utils');
const { AbortError, TimeoutError, WorkerError } = require('./errors');

// ============================================================================
// SINGLE EXECUTION
// ============================================================================

/**
 * @typedef {Object} ExecutionOptions
 * @property {boolean} safe - Return result wrapper instead of throwing
 * @property {number|null} timeout - Execution timeout (ms)
 * @property {string} poolType - Worker pool type ('normal' | 'generator')
 * @property {Transferable[]} transfer - Zero-copy transferables
 * @property {AbortSignal|null} signal - Cancellation signal
 * @property {Object|null} context - Closure variable injection
 * @property {Object|null} retry - Retry configuration
 */

/**
 * Executes a function once in a worker thread (no retry).
 * 
 * ## Execution Steps
 * 
 * 1. **Pre-flight checks**: Verify abort signal not already triggered
 * 2. **Worker acquisition**: Request from pool with affinity preference
 * 3. **Handler setup**: Message, error, exit listeners
 * 4. **Timeout setup**: Timer that terminates worker on expiry
 * 5. **Abort setup**: Handler that terminates worker on signal
 * 6. **Task dispatch**: postMessage with function, args, context
 * 7. **Response handling**: Parse ok/error response
 * 8. **Cleanup**: Remove listeners, release worker, update metrics
 * 
 * ## Why fnHash for Affinity
 * 
 * We compute a hash of the function source and pass it to `requestWorker()`.
 * The pool uses this to prefer workers that have already executed this
 * function, benefiting from:
 * - Cached compiled function (no vm.Script call)
 * - V8 TurboFan optimized code
 * - Better CPU cache locality
 * 
 * @param {Function|{toString: Function}} fn - Function to execute
 * @param {Array} args - Arguments to pass to the function
 * @param {ExecutionOptions} options - Execution configuration
 * @returns {Promise<*>} Function return value (or safe wrapper if safe=true)
 * @throws {AbortError} If aborted via signal
 * @throws {TimeoutError} If execution exceeds timeout
 * @throws {QueueFullError} If task queue is full
 * @throws {WorkerError} If function throws inside worker
 */
async function executeOnce(fn, args, { 
  safe = false, 
  timeout = null, 
  poolType = 'normal', 
  transfer = [], 
  signal = null,
  context = null,
  priority = 'normal'
} = {}) {
  const startTime = Date.now();
  const fnString = fn.toString();
  
  // Compute hash for worker affinity (routes same function to same worker)
  const fnHash = fastHash(fnString);
  
  // ─────────────────────────────────────────────────────────────────────────
  // Pre-execution checks
  // ─────────────────────────────────────────────────────────────────────────
  if (signal?.aborted) {
    const err = new AbortError(signal.reason?.message);
    if (safe) return { status: 'rejected', error: err };
    throw err;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Acquire worker (with affinity preference)
  // ─────────────────────────────────────────────────────────────────────────
  let workerInfo;
  try {
    workerInfo = await requestWorker(poolType, priority, fnHash);
  } catch (err) {
    if (safe) return { status: 'rejected', error: err };
    throw err;
  }

  const { entry, worker, temporary } = workerInfo;

  // ─────────────────────────────────────────────────────────────────────────
  // Execute in worker
  // ─────────────────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let abortHandler;

    /**
     * Cleanup - removes listeners and releases worker.
     */
    const cleanup = (executionTime, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      releaseWorker(entry, worker, temporary, executionTime, failed, fnHash);
    };

    /**
     * Settles the promise with success or failure.
     */
    const settle = (isSuccess, value) => {
      if (settled) return;
      cleanup(Date.now() - startTime, !isSuccess);
      
      // Update metrics
      isSuccess ? metrics.totalTasksExecuted++ : metrics.totalTasksFailed++;
      
      // Handle safe mode
      if (safe) {
        resolve(isSuccess ? { status: 'fulfilled', value } : { status: 'rejected', error: value });
      } else {
        isSuccess ? resolve(value) : reject(value);
      }
    };

    // Worker message handler
    const onMessage = (msg) => {
      // Handle console logs from worker
      if (msg.type === 'log') {
        const logFn = console[msg.level] || console.log;
        logFn('[worker]', ...msg.args);
        return;
      }
      
      if (msg.ok) {
        settle(true, msg.value);
      } else {
        const err = new WorkerError(msg.error.message);
        err.name = msg.error.name || 'Error';
        if (msg.error.stack) err.stack = msg.error.stack;
        settle(false, err);
      }
    };

    // Worker error handler
    const onError = (err) => settle(false, new WorkerError(err.message, err));
    
    // Worker exit handler
    const onExit = (code) => {
      if (!settled && code !== 0) settle(false, new WorkerError(`Worker exited with code ${code}`));
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Setup abort signal handler
    // ─────────────────────────────────────────────────────────────────────────
    if (signal) {
      abortHandler = () => {
        worker.terminate();
        settle(false, new AbortError(signal.reason?.message));
      };
      signal.addEventListener('abort', abortHandler);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup timeout
    // ─────────────────────────────────────────────────────────────────────────
    if (timeout) {
      timer = setTimeout(() => {
        worker.terminate();
        settle(false, new TimeoutError(timeout));
      }, timeout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Attach listeners and send task
    // ─────────────────────────────────────────────────────────────────────────
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    const message = { fn: fnString, args, context };
    transfer?.length > 0 ? worker.postMessage(message, transfer) : worker.postMessage(message);
  });
}

// ============================================================================
// EXECUTION WITH RETRY
// ============================================================================

/**
 * Executes a function with optional retry logic and exponential backoff.
 * 
 * ## Retry Behavior
 * 
 * When retry is enabled (`options.retry.enabled = true`):
 * 
 * 1. Execute the function via `executeOnce()`
 * 2. On success: return result immediately
 * 3. On failure:
 *    - AbortError/TimeoutError: **Never retry** (intentional failures)
 *    - Other errors: Wait with backoff, then retry
 * 4. After `maxAttempts` failures: throw last error
 * 
 * ## Exponential Backoff with Jitter
 * 
 * Delay = min(baseDelay * (backoffFactor ^ attempt), maxDelay) * random(0.5, 1.5)
 * 
 * Example with defaults (baseDelay=100, backoffFactor=2, maxDelay=5000):
 * - Attempt 1 fails: wait ~100ms (50-150ms with jitter)
 * - Attempt 2 fails: wait ~200ms (100-300ms)
 * - Attempt 3 fails: wait ~400ms (200-600ms)
 * - ... capped at 5000ms
 * 
 * ## Why Jitter
 * 
 * Without jitter, if 100 tasks fail at the same time, they all retry
 * at exactly 100ms, 200ms, 400ms... causing "thundering herd" spikes.
 * Jitter spreads retries across time.
 * 
 * @param {Function|{toString: Function}} fn - Function to execute
 * @param {Array} args - Arguments to pass to the function
 * @param {ExecutionOptions} options - Execution configuration
 * @returns {Promise<*>} Function return value (or safe wrapper if safe=true)
 */
async function execute(fn, args, options = {}) {
  const { retry: retryOpts = config.retry, safe = false } = options;
  
  // No retry enabled - execute once
  if (!retryOpts?.enabled) {
    return executeOnce(fn, args, options);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Retry loop with exponential backoff
  // ─────────────────────────────────────────────────────────────────────────
  const { maxAttempts, baseDelay, maxDelay, backoffFactor } = retryOpts;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await executeOnce(fn, args, { ...options, safe: false });
      return safe ? { status: 'fulfilled', value: result } : result;
    } catch (err) {
      lastError = err;
      
      // Never retry abort or timeout - these are intentional
      if (err instanceof AbortError || err instanceof TimeoutError) break;
      
      // Wait before next attempt (except last)
      if (attempt < maxAttempts - 1) {
        metrics.totalRetries++;
        await sleep(calculateBackoff(attempt, baseDelay, maxDelay, backoffFactor));
      }
    }
  }

  // All attempts failed
  if (safe) return { status: 'rejected', error: lastError };
  throw lastError;
}

module.exports = {
  executeOnce,
  execute
};

