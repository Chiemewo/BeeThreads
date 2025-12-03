/**
 * @fileoverview Stream executor for generator functions.
 * 
 * Fluent API:
 * - `.usingParams(...args)` - set generator arguments
 * - `.setContext({...})` - inject closure variables
 * - `.execute()` - start streaming
 * 
 * @module bee-threads/stream-executor
 */

'use strict';

const { requestWorker, releaseWorker } = require('./pool');
const { validateFunction } = require('./validation');
const { WorkerError } = require('./errors');

// ============================================================================
// STREAM EXECUTOR FACTORY
// ============================================================================

/**
 * Creates a stream executor for generators.
 * 
 * @param {Object} state - Executor state
 * @param {string} state.fnString - Serialized generator
 * @param {Object|null} state.context - Closure context
 * @param {Array} state.args - Generator arguments
 * @param {Transferable[]} state.transfer - Zero-copy transferables
 * @returns {StreamExecutor} Chainable executor
 */
function createStreamExecutor(state) {
  const { fnString, context, args, transfer } = state;
  
  const executor = {
    /**
     * Sets generator arguments.
     * 
     * @param {...*} params - Arguments
     * @returns {StreamExecutor} New executor
     */
    usingParams(...params) {
      return createStreamExecutor({
        fnString,
        context,
        args: [...args, ...params],
        transfer
      });
    },
    
    /**
     * Injects closure variables.
     * 
     * @param {Object} ctx - Variables to inject
     * @returns {StreamExecutor} New executor
     * 
     * @example
     * const multiplier = 2;
     * beeThreads
     *   .stream(function* (n) {
     *     for (let i = 1; i <= n; i++) yield i * multiplier;
     *   })
     *   .usingParams(5)
     *   .setContext({ multiplier })
     *   .execute()
     */
    setContext(ctx) {
      if (typeof ctx !== 'object' || ctx === null) {
        throw new TypeError('setContext() requires a non-null object');
      }
      return createStreamExecutor({
        fnString,
        context: ctx,
        args,
        transfer
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
     * @returns {StreamExecutor} New executor with transfer list
     * 
     * @example
     * const buffer = new ArrayBuffer(1024 * 1024);
     * beeThreads
     *   .stream(function* (buf) { ... })
     *   .usingParams(buffer)
     *   .transfer([buffer])
     *   .execute()
     */
    transfer(list) {
      return createStreamExecutor({
        fnString,
        context,
        args,
        transfer: list
      });
    },
    
    /**
     * Starts streaming the generator.
     * 
     * @returns {ReadableStream} Stream of yielded values
     */
    execute() {
      let streamWorker = null;
      let workerEntry = null;
      let isTemporary = false;
      let closed = false;
      let returnValue = undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (streamWorker) {
          streamWorker.removeAllListeners('message');
          streamWorker.removeAllListeners('error');
          streamWorker.removeAllListeners('exit');
          releaseWorker(workerEntry, streamWorker, isTemporary);
        }
      };

      const readable = new ReadableStream({
        async start(controller) {
          try {
            const workerInfo = await requestWorker('generator');
            workerEntry = workerInfo.entry;
            streamWorker = workerInfo.worker;
            isTemporary = workerInfo.temporary;

            streamWorker.on('message', msg => {
              if (closed) return;
              
              // Handle console logs from worker
              if (msg.type === 'log') {
                const logFn = console[msg.level] || console.log;
                logFn('[worker]', ...msg.args);
                return;
              }
              
              switch (msg.type) {
                case 'yield':
                  controller.enqueue(msg.value);
                  break;
                case 'return':
                  returnValue = msg.value;
                  break;
                case 'end':
                  controller.close();
                  cleanup();
                  break;
                case 'error':
                  const err = new WorkerError(msg.error.message);
                  err.name = msg.error.name || 'Error';
                  if (msg.error.stack) err.stack = msg.error.stack;
                  controller.error(err);
                  cleanup();
                  break;
              }
            });

            streamWorker.on('error', err => {
              if (closed) return;
              controller.error(new WorkerError(err.message, err));
              cleanup();
            });

            streamWorker.on('exit', code => {
              if (closed) return;
              if (code !== 0) {
                controller.error(new WorkerError(`Worker exited with code ${code}`));
              }
              cleanup();
            });

            const message = { fn: fnString, args, context };
            transfer?.length > 0 
              ? streamWorker.postMessage(message, transfer) 
              : streamWorker.postMessage(message);
          } catch (err) {
            controller.error(err);
            cleanup();
          }
        },
        
        cancel() {
          if (streamWorker && !closed) streamWorker.terminate();
          cleanup();
        }
      });

      Object.defineProperty(readable, 'returnValue', { 
        get: () => returnValue 
      });
      
      return readable;
    }
  };
  
  return executor;
}

// ============================================================================
// STREAM RUNNER
// ============================================================================

/**
 * Creates a stream runner for a generator.
 * 
 * @param {GeneratorFunction} genFn - Generator function
 * @returns {StreamExecutor} Chainable executor
 * 
 * @example
 * const stream = beeThreads
 *   .stream(function* (n) { for(let i=0; i<n; i++) yield i; })
 *   .usingParams(5)
 *   .execute();
 * 
 * for await (const v of stream) console.log(v);
 */
function stream(genFn) {
  validateFunction(genFn);
  return createStreamExecutor({
    fnString: genFn.toString(),
    context: null,
    args: [],
    transfer: []
  });
}

module.exports = {
  createStreamExecutor,
  stream
};
