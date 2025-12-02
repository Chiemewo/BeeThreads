/**
 * @fileoverview Executor builder for bee-threads.
 * 
 * ## Why This File Exists
 * 
 * This module implements the fluent API builder pattern for task execution.
 * It decouples the user-facing API from the internal execution engine,
 * allowing for a clean chainable interface.
 * 
 * ## Design Decisions
 * 
 * 1. **Immutable State**: Each method returns a NEW executor with updated state.
 *    This prevents accidental state mutation and allows executor reuse.
 * 
 * 2. **Fluent API**: Methods can be chained in any order (except `execute()`
 *    which must be last). This provides maximum flexibility.
 * 
 * 3. **Separation**: The executor only builds the task configuration.
 *    Actual execution is delegated to `execution.js`.
 * 
 * @module bee-threads/executor
 * @internal
 */

'use strict';

const { config } = require('./config');
const { execute } = require('./execution');
const { validateFunction } = require('./validation');

// ============================================================================
// EXECUTOR FACTORY
// ============================================================================

/**
 * Internal state for an executor instance.
 * 
 * @typedef {Object} ExecutorState
 * @property {string} fnString - The serialized function source code
 * @property {Object} options - Accumulated execution options
 * @property {Array} args - Function arguments to pass
 * @internal
 */

/**
 * Creates an immutable, chainable executor.
 * 
 * ## Why This Pattern
 * 
 * The executor pattern allows users to:
 * 1. Configure execution options incrementally
 * 2. Reuse partially configured executors
 * 3. Have a consistent, predictable API
 * 
 * Each method returns a NEW executor to maintain immutability.
 * This prevents subtle bugs from shared mutable state.
 * 
 * @param {ExecutorState} state - Current executor state
 * @returns {Executor} Chainable executor object
 * @internal
 * 
 * @example
 * // Internal usage
 * const exec = createExecutor({
 *   fnString: '(x) => x * 2',
 *   options: {},
 *   args: []
 * });
 */
function createExecutor(state) {
  const { fnString, options, args } = state;
  
  /**
   * The executor object with all chainable methods.
   * 
   * @typedef {Object} Executor
   * @property {Function} usingParams - Sets function arguments
   * @property {Function} setContext - Injects closure variables
   * @property {Function} signal - Attaches AbortSignal
   * @property {Function} transfer - Specifies transferables
   * @property {Function} retry - Enables retry with backoff
   * @property {Function} execute - Runs the function
   */
  const executor = {
    /**
     * Sets the arguments to pass to the function.
     * 
     * Multiple calls accumulate arguments (useful for partial application).
     * For curried functions, pass all arguments at once - the worker
     * applies them sequentially.
     * 
     * @param {...*} params - Arguments to pass
     * @returns {Executor} New executor with arguments set
     * 
     * @example
     * // Regular function
     * executor.usingParams(1, 2, 3).execute()
     * // → fn(1, 2, 3)
     * 
     * // Curried function
     * executor.usingParams(1, 2, 3).execute()
     * // → fn(1)(2)(3)
     * 
     * // Chained calls accumulate
     * executor.usingParams(1).usingParams(2).execute()
     * // → fn(1, 2)
     */
    usingParams(...params) {
      return createExecutor({
        fnString,
        options,
        args: [...args, ...params]
      });
    },
    
    /**
     * Injects external variables into the function's scope.
     * 
     * ## Why This Exists
     * 
     * Functions are serialized to strings for transfer to workers.
     * This means closures lose their captured variables.
     * `setContext` solves this by explicitly passing variables
     * to be injected into the function's scope.
     * 
     * @param {Object} context - Key-value pairs to inject
     * @returns {Executor} New executor with context set
     * @throws {TypeError} If context is not a non-null object
     * 
     * @example
     * const TAX = 0.2;
     * executor
     *   .setContext({ TAX })
     *   .usingParams(100)
     *   .execute()
     * // Inside worker: TAX is available as 0.2
     */
    setContext(context) {
      if (typeof context !== 'object' || context === null) {
        throw new TypeError('setContext() requires a non-null object');
      }
      return createExecutor({
        fnString,
        options: { ...options, context },
        args
      });
    },
    
    /**
     * Attaches an AbortSignal for cancellation support.
     * 
     * When the signal is aborted:
     * 1. The worker is terminated immediately
     * 2. The promise rejects with AbortError
     * 
     * @param {AbortSignal} abortSignal - Signal from AbortController
     * @returns {Executor} New executor with signal attached
     * 
     * @example
     * const ctrl = new AbortController();
     * setTimeout(() => ctrl.abort(), 5000);
     * 
     * executor.signal(ctrl.signal).execute()
     */
    signal(abortSignal) {
      return createExecutor({
        fnString,
        options: { ...options, signal: abortSignal },
        args
      });
    },
    
    /**
     * Specifies transferable objects for zero-copy transfer.
     * 
     * ArrayBuffers and other transferables are moved to the worker
     * without copying, improving performance for large data.
     * 
     * **Warning**: Transferred objects become unusable in the main thread.
     * 
     * @param {Transferable[]} list - Objects to transfer
     * @returns {Executor} New executor with transfer list
     * 
     * @example
     * const buffer = new ArrayBuffer(1024 * 1024);
     * executor
     *   .transfer([buffer])
     *   .usingParams(buffer)
     *   .execute()
     * // buffer is now detached in main thread
     */
    transfer(list) {
      return createExecutor({
        fnString,
        options: { ...options, transfer: list },
        args
      });
    },
    
    /**
     * Enables automatic retry with exponential backoff.
     * 
     * On failure, the task is retried with increasing delays.
     * AbortError and TimeoutError are NOT retried (intentional failures).
     * 
     * @param {Object} [retryOptions] - Override default retry settings
     * @param {number} [retryOptions.maxAttempts] - Maximum attempts
     * @param {number} [retryOptions.baseDelay] - Initial delay (ms)
     * @param {number} [retryOptions.maxDelay] - Maximum delay (ms)
     * @param {number} [retryOptions.backoffFactor] - Delay multiplier
     * @returns {Executor} New executor with retry enabled
     * 
     * @example
     * executor
     *   .retry({ maxAttempts: 5, baseDelay: 200 })
     *   .execute()
     */
    retry(retryOptions = {}) {
      return createExecutor({
        fnString,
        options: { 
          ...options, 
          retry: { enabled: true, ...config.retry, ...retryOptions } 
        },
        args
      });
    },
    
    /**
     * Sets the task priority for queue ordering.
     * 
     * When all workers are busy, tasks are queued. Higher priority
     * tasks are processed before lower priority tasks.
     * 
     * @param {'high'|'normal'|'low'} level - Priority level
     * @returns {Executor} New executor with priority set
     * 
     * @example
     * // Critical task - process first
     * await beeThreads
     *   .run(criticalTask)
     *   .priority('high')
     *   .execute();
     * 
     * // Background task - process last
     * await beeThreads
     *   .run(backgroundTask)
     *   .priority('low')
     *   .execute();
     */
    priority(level) {
      return createExecutor({
        fnString,
        options: { ...options, priority: level },
        args
      });
    },
    
    /**
     * Executes the function in a worker thread.
     * 
     * This is the terminal operation that triggers execution.
     * All configuration must be done before calling this.
     * 
     * @returns {Promise<*>} The function's return value
     * @throws {WorkerError} If the function throws
     * @throws {TimeoutError} If execution exceeds timeout
     * @throws {AbortError} If execution is aborted
     * @throws {QueueFullError} If task queue is full
     * 
     * @example
     * const result = await executor.execute();
     */
    execute() {
      return execute(
        { toString: () => fnString }, 
        args, 
        { ...options, poolType: 'normal' }
      );
    }
  };
  
  return executor;
}

// ============================================================================
// CURRIED RUNNER FACTORY
// ============================================================================

/**
 * Creates a runner function with preset base options.
 * 
 * ## Why This Exists
 * 
 * This factory allows `beeThreads.run`, `beeThreads.safeRun`, etc.
 * to share the executor creation logic while having different
 * default options (e.g., safe mode, timeout).
 * 
 * @param {Object} baseOptions - Default options for all executors
 * @returns {Function} A function that accepts a user function and returns an executor
 * @internal
 */
function createCurriedRunner(baseOptions = {}) {
  /**
   * Accepts a function and creates an executor for it.
   * 
   * @param {Function} fn - The function to run in a worker
   * @returns {Executor} Chainable executor
   * @throws {TypeError} If fn is not a function
   */
  return function run(fn) {
    validateFunction(fn);
    return createExecutor({
      fnString: fn.toString(),
      options: baseOptions,
      args: []
    });
  };
}

module.exports = {
  createExecutor,
  createCurriedRunner
};
