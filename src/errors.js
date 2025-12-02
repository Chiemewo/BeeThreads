/**
 * @fileoverview Custom error classes for bee-threads library.
 * 
 * All errors extend AsyncThreadError which provides error codes
 * for programmatic error handling.
 * 
 * Error Codes:
 * - ERR_ABORTED: Operation was cancelled via AbortSignal
 * - ERR_TIMEOUT: Worker exceeded timeout limit
 * - ERR_QUEUE_FULL: Task queue reached maximum capacity
 * - ERR_WORKER: Error occurred inside the worker thread
 * - ERR_SHUTDOWN: Pool is shutting down
 * 
 * @module bee-threads/errors
 */

'use strict';

/**
 * Base error class for all bee-threads errors.
 * Provides a consistent error interface with error codes.
 * 
 * @class AsyncThreadError
 * @extends Error
 * 
 * @example
 * try {
 *   await beeThreads.run(fn)();
 * } catch (err) {
 *   if (err instanceof AsyncThreadError) {
 *     console.log(err.code); // 'ERR_WORKER', 'ERR_TIMEOUT', etc.
 *   }
 * }
 */
class AsyncThreadError extends Error {
  /**
   * Creates a new AsyncThreadError.
   * 
   * @param {string} message - Human-readable error message
   * @param {string} code - Machine-readable error code (e.g., 'ERR_TIMEOUT')
   */
  constructor(message, code) {
    super(message);
    this.name = 'AsyncThreadError';
    this.code = code;
    
    // Maintains proper stack trace in V8 environments (Node.js)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when an operation is cancelled via AbortSignal.
 * 
 * This error is thrown when:
 * - AbortController.abort() is called while task is running
 * - An already-aborted signal is passed to a task
 * 
 * @class AbortError
 * @extends AsyncThreadError
 * 
 * @example
 * const controller = new AbortController();
 * controller.abort();
 * 
 * try {
 *   await beeThreads.run(fn).signal(controller.signal)();
 * } catch (err) {
 *   if (err instanceof AbortError) {
 *     console.log('Operation was cancelled');
 *   }
 * }
 */
class AbortError extends AsyncThreadError {
  /**
   * Creates a new AbortError.
   * 
   * @param {string} [message='Operation was aborted'] - Error message
   */
  constructor(message = 'Operation was aborted') {
    super(message, 'ERR_ABORTED');
    this.name = 'AbortError';
  }
}

/**
 * Error thrown when a worker exceeds its timeout limit.
 * 
 * This error is thrown when:
 * - A task running with withTimeout() exceeds the time limit
 * - The worker is forcefully terminated due to timeout
 * 
 * @class TimeoutError
 * @extends AsyncThreadError
 * 
 * @example
 * try {
 *   await beeThreads.withTimeout(1000)(slowFn)();
 * } catch (err) {
 *   if (err instanceof TimeoutError) {
 *     console.log(`Timed out after ${err.timeout}ms`);
 *   }
 * }
 */
class TimeoutError extends AsyncThreadError {
  /**
   * Creates a new TimeoutError.
   * 
   * @param {number} ms - The timeout value that was exceeded (in milliseconds)
   */
  constructor(ms) {
    super(`Worker timed out after ${ms}ms`, 'ERR_TIMEOUT');
    this.name = 'TimeoutError';
    /** @type {number} The timeout value in milliseconds */
    this.timeout = ms;
  }
}

/**
 * Error thrown when the task queue is full.
 * 
 * This error is thrown when:
 * - All workers are busy
 * - All temporary workers are in use
 * - The queue has reached maxQueueSize
 * 
 * @class QueueFullError
 * @extends AsyncThreadError
 * 
 * @example
 * try {
 *   await beeThreads.run(fn)();
 * } catch (err) {
 *   if (err instanceof QueueFullError) {
 *     console.log(`Queue full: max ${err.maxSize} tasks`);
 *     // Consider increasing maxQueueSize or poolSize
 *   }
 * }
 */
class QueueFullError extends AsyncThreadError {
  /**
   * Creates a new QueueFullError.
   * 
   * @param {number} maxSize - The maximum queue size that was reached
   */
  constructor(maxSize) {
    super(`Task queue full (max ${maxSize})`, 'ERR_QUEUE_FULL');
    this.name = 'QueueFullError';
    /** @type {number} Maximum queue size configured */
    this.maxSize = maxSize;
  }
}

/**
 * Error thrown when an error occurs inside the worker thread.
 * 
 * This wraps errors from:
 * - Exceptions thrown by the user's function
 * - Worker process crashes
 * - Unexpected worker exits
 * 
 * @class WorkerError
 * @extends AsyncThreadError
 * 
 * @example
 * try {
 *   await beeThreads.run(() => { throw new Error('oops'); })();
 * } catch (err) {
 *   if (err instanceof WorkerError) {
 *     console.log('Worker error:', err.message);
 *     if (err.cause) {
 *       console.log('Original error:', err.cause);
 *     }
 *   }
 * }
 */
class WorkerError extends AsyncThreadError {
  /**
   * Creates a new WorkerError.
   * 
   * @param {string} message - Error message from the worker
   * @param {Error} [originalError] - The original error that caused this
   */
  constructor(message, originalError) {
    super(message, 'ERR_WORKER');
    this.name = 'WorkerError';
    
    // Store original error for debugging
    if (originalError) {
      /** @type {Error|undefined} The original error that caused this */
      this.cause = originalError;
      // Preserve original stack trace if available
      this.stack = originalError.stack || this.stack;
    }
  }
}

// Export all error classes
module.exports = {
  AsyncThreadError,
  AbortError,
  TimeoutError,
  QueueFullError,
  WorkerError
};

