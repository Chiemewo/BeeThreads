/**
 * @fileoverview Worker thread script for executing generator functions.
 * 
 * This script handles generators and async generators, streaming
 * yielded values back to the main thread as they are produced.
 * 
 * @module bee-threads/generator-worker
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const { createFunctionCache } = require('./cache');

// ============================================================================
// GLOBAL ERROR HANDLERS - Prevent worker crash without response
// ============================================================================

/**
 * Catches uncaught exceptions that would otherwise crash the worker.
 */
process.on('uncaughtException', (err) => {
  try {
    parentPort.postMessage({ 
      type: 'error',
      error: { 
        name: err.name || 'UncaughtException', 
        message: err.message || String(err),
        stack: err.stack 
      } 
    });
  } catch {
    process.exit(1);
  }
});

/**
 * Catches unhandled promise rejections.
 */
process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    parentPort.postMessage({ 
      type: 'error',
      error: { 
        name: err.name || 'UnhandledRejection', 
        message: err.message || String(reason),
        stack: err.stack 
      } 
    });
  } catch {
    process.exit(1);
  }
});

// ============================================================================
// FUNCTION CACHE
// ============================================================================

/**
 * LRU cache for compiled generator functions.
 * Uses vm.Script for faster compilation with context.
 */
const cacheSize = workerData?.functionCacheSize || 100;
const fnCache = createFunctionCache(cacheSize);

/**
 * Expose cache for debugging.
 * Access via: globalThis.BeeCache.stats()
 */
globalThis.BeeCache = fnCache;

// ============================================================================
// CONSOLE REDIRECTION
// ============================================================================

/**
 * Redirects console.log/warn/error to main thread.
 * 
 * Worker threads don't share stdout with main thread by default.
 * This intercepts console methods and sends logs via postMessage.
 */
console.log = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'log', args: args.map(String) });
};

console.warn = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'warn', args: args.map(String) });
};

console.error = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'error', args: args.map(String) });
};

console.info = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'info', args: args.map(String) });
};

console.debug = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'debug', args: args.map(String) });
};

// ============================================================================
// ERROR SERIALIZATION
// ============================================================================

/**
 * Serializes an error for transmission to main thread.
 * 
 * @param {Error|any} e - Error to serialize
 * @returns {{ name: string, message: string, stack?: string }}
 */
/**
 * Serializes error for transmission to main thread.
 * 
 * ## Why We Check e.name Instead of instanceof
 * 
 * Errors from vm.createContext() have a different Error class than
 * the main Node.js context. This means `e instanceof Error` returns
 * false even for real Error objects from the vm context.
 * 
 * @param {Error|any} e - Error to serialize
 * @returns {{ name: string, message: string, stack?: string }}
 */
function serializeError(e) {
  // Check for error-like objects (has name and message properties)
  // This works across different vm contexts where instanceof fails
  if (e && typeof e === 'object' && e.name && e.message !== undefined) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { name: 'Error', message: String(e) };
}

// ============================================================================
// FUNCTION SOURCE VALIDATION (with caching)
// ============================================================================

/**
 * Pre-compiled regex patterns for function/generator validation.
 * Compiled once at module load for better performance.
 * @type {RegExp[]}
 */
const VALID_FUNCTION_PATTERNS = [
  /^function\s*\*?\s*\w*\s*\(/,        // function() or function*()
  /^async\s+function\s*\*?\s*\w*\s*\(/, // async function() or async function*()
  /^\(.*\)\s*=>/,                       // (args) =>
  /^\w+\s*=>/,                          // arg =>
  /^async\s*\(.*\)\s*=>/,               // async (args) =>
  /^async\s+\w+\s*=>/,                  // async arg =>
  /^\(\s*\[/,                           // ([destructured]) =>
  /^\(\s*\{/,                           // ({destructured}) =>
];

/**
 * Cache of validated function sources.
 * Avoids re-running regex validation on every call.
 * @type {Set<string>}
 */
const validatedSources = new Set();
const MAX_VALIDATION_CACHE = 200;

/**
 * Validates that source looks like a valid function/generator (with caching).
 * 
 * Once validated, the source is cached so subsequent calls skip
 * regex matching entirely.
 * 
 * @param {string} src - Function source code
 * @throws {TypeError} If source is invalid
 */
function validateFunctionSource(src) {
  if (typeof src !== 'string') {
    throw new TypeError('Function source must be a string');
  }
  
  // Fast path: already validated
  if (validatedSources.has(src)) {
    return;
  }
  
  const trimmed = src.trim();
  
  if (!VALID_FUNCTION_PATTERNS.some(p => p.test(trimmed))) {
    throw new TypeError('Invalid function source - does not appear to be a function');
  }
  
  // Cache validation result (with bounded size)
  if (validatedSources.size >= MAX_VALIDATION_CACHE) {
    const iterator = validatedSources.values();
    for (let i = 0; i < 50; i++) {
      validatedSources.delete(iterator.next().value);
    }
  }
  validatedSources.add(src);
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

/**
 * Main message handler for generator execution.
 * 
 * Input: { fn: string, args: any[], context?: object }
 * 
 * Output messages:
 * - { type: 'yield', value: any }  - Each yielded value
 * - { type: 'return', value: any } - Generator return value (if any)
 * - { type: 'end' }                - Generator completed
 * - { type: 'error', error: obj }  - Error occurred
 */
parentPort.on('message', ({ fn: src, args, context }) => {
  try {
    // Step 1: Validate function source
    validateFunctionSource(src);
    
    // Step 2: Get compiled function from cache (or compile and cache it)
    const fn = fnCache.getOrCompile(src, context);
    
    if (typeof fn !== 'function') {
      throw new TypeError('Evaluated source did not produce a function');
    }
    
    // Step 3: Call function to get generator/iterator
    const gen = fn(...args);
    
    // Step 4: Verify it's actually an iterator
    if (!gen || typeof gen.next !== 'function') {
      throw new TypeError('Function must return a generator/iterator');
    }

    /**
     * Recursively processes generator yields.
     * Uses setImmediate to prevent stack overflow on long generators.
     * 
     * @param {IteratorResult} next - Current iterator result
     */
    function step(next) {
      // Generator finished - send return value (if any) and end
      if (next.done) {
        // Generators can return a value: function* () { return 42; }
        if (next.value !== undefined) {
          parentPort.postMessage({ type: 'return', value: next.value });
        }
        parentPort.postMessage({ type: 'end' });
        return;
      }

      const value = next.value;

      // Handle Promise-yielding generators (yield fetch(...))
      if (value && typeof value.then === 'function') {
        value
          .then(v => {
            parentPort.postMessage({ type: 'yield', value: v });
            step(gen.next());
          })
          .catch(e => {
            parentPort.postMessage({ type: 'error', error: serializeError(e) });
            // Gracefully close the generator
            try { gen.return?.(); } catch {}
          });
      } else {
        // Sync value - send and continue
        parentPort.postMessage({ type: 'yield', value });
        // setImmediate prevents stack overflow on long sync generators
        setImmediate(() => step(gen.next()));
      }
    }

    // Start iteration
    step(gen.next());
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: serializeError(e) });
  }
});
