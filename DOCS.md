# bee-threads - Internal Documentation

> Deep dive into architecture, decisions, and performance optimizations.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File-by-File Breakdown](#file-by-file-breakdown)
3. [Core Decisions & Rationale](#core-decisions--rationale)
4. [Performance Architecture](#performance-architecture)
5. [Data Flow](#data-flow)
6. [Contributing Guide](#contributing-guide)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             User Code                                    │
│   bee(fn)(args)  or  beeThreads.run(fn).usingParams(...).execute()      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         index.js (Public API)                            │
│   • bee() - Simple curried API                                          │
│   • beeThreads.run/safeRun/stream/all/allSettled                        │
│   • configure/shutdown/warmup/getPoolStats                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
           ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
           │ executor.js  │ │stream-exec.js│ │   pool.js    │
           │ Fluent API   │ │ Generator API│ │ Worker mgmt  │
           └──────────────┘ └──────────────┘ └──────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        execution.js (Task Engine)                        │
│   • Worker communication                                                 │
│   • Timeout/abort handling                                              │
│   • Retry with exponential backoff                                      │
│   • Metrics tracking                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
┌─────────────────────────────┐   ┌─────────────────────────────┐
│       worker.js             │   │    generator-worker.js      │
│   • vm.Script compilation   │   │   • Streaming yields        │
│   • LRU function cache      │   │   • Return value capture    │
│   • Curried fn support      │   │   • Same optimizations      │
│   • Console forwarding      │   │                             │
└─────────────────────────────┘   └─────────────────────────────┘
```

---

## File-by-File Breakdown

### `src/index.js` - Public API

**Purpose:** Single entry point. Hides internal complexity.

**Why it exists:**
- Users only need `require('bee-threads')` - no deep imports
- Centralizes all public exports
- Acts as facade pattern for internal modules

**Key exports:**
| Export | Description |
|--------|-------------|
| `bee(fn)` | Simple curried API for quick tasks |
| `beeThreads` | Full API with all features |
| `AbortError` | Thrown on cancellation |
| `TimeoutError` | Thrown on timeout |
| `QueueFullError` | Thrown when queue limit reached |
| `WorkerError` | Wraps errors from worker |

---

### `src/config.js` - Centralized State

**Purpose:** Single source of truth for ALL mutable state.

**Why it exists:**
- Debugging: One place to inspect entire library state
- Testing: Easy to reset state between tests
- Predictability: No scattered global variables

**State managed:**
```js
config        // User settings (poolSize, timeout, retry, etc)
pools         // Active workers { normal: Worker[], generator: Worker[] }
poolCounters  // O(1) counters { busy: N, idle: N }
queues        // Pending tasks by priority { high: [], normal: [], low: [] }
metrics       // Execution statistics
```

**Why poolCounters exist:**
Instead of `pools.normal.filter(w => !w.busy).length` (O(n)), we maintain counters that update on every state change. This makes `getWorker()` checks O(1).

---

### `src/pool.js` - Worker Pool Management

**Purpose:** Worker lifecycle management and intelligent task routing.

**Key responsibilities:**
1. Create workers with proper configuration
2. Select best worker for each task (load balancing + affinity)
3. Return workers to pool after use
4. Clean up idle workers
5. Handle overflow with temporary workers

**Selection Strategy (in priority order):**

| Priority | Strategy | Why |
|----------|----------|-----|
| 1 | **Affinity match** | Worker already has function compiled & V8-optimized |
| 2 | **Least-used idle** | Distributes load evenly across pool |
| 3 | **Create new pooled** | Pool not at capacity |
| 4 | **Create temporary** | Overflow handling, terminated after use |
| 5 | **Queue task** | No resources available |

**Why affinity tracking:**
V8's TurboFan JIT compiler optimizes "hot" functions after ~7 calls. By routing the same function to the same worker:
- Function is already compiled in cache (no vm.Script call)
- V8 has optimized machine code ready
- Better CPU cache locality

We track this via `functionHashes` Set per worker (capped at 50 entries).

---

### `src/execution.js` - Task Engine

**Purpose:** Core execution logic - worker communication and lifecycle.

**Why separated from pool.js:**
- Single responsibility: pool manages workers, execution manages tasks
- Easier testing: can mock pool interactions
- Cleaner code: execution logic doesn't mix with pool logic

**Execution flow:**
```
1. Check if AbortSignal already aborted
2. Compute function hash for affinity
3. Request worker (may queue if none available)
4. Setup message/error/exit handlers
5. Setup timeout timer (if configured)
6. Setup abort handler (if configured)
7. Send task: { fn: string, args: [], context: {} }
8. Wait for response
9. Cleanup (remove listeners, release worker)
10. Update metrics
11. Resolve/reject promise
```

**Why retry is separate from executeOnce:**
- `executeOnce` is pure - no side effects beyond single execution
- `execute` wraps with retry loop and backoff
- Allows testing retry logic independently

---

### `src/executor.js` - Fluent API Builder

**Purpose:** Creates the chainable API users interact with.

**Design pattern:** Immutable Builder

```js
// Each method returns NEW executor (original unchanged)
const exec1 = beeThreads.run(fn);
const exec2 = exec1.usingParams(1);  // exec1 unaffected
const exec3 = exec2.setContext({});  // exec2 unaffected
```

**Why immutable:**
1. **Reusability:** Base executor can be shared
   ```js
   const base = beeThreads.run(fn).setContext({ API_KEY });
   await base.usingParams(1).execute();
   await base.usingParams(2).execute(); // Same context, different params
   ```
2. **Predictability:** No accidental state mutation
3. **Concurrency-safe:** Multiple calls don't interfere

**Why methods can be called in any order:**
- State is accumulated, not dependent on order
- User freedom - configure in whatever order makes sense
- Only `execute()` must be last (triggers execution)

---

### `src/cache.js` - LRU Function Cache

**Purpose:** Avoid repeated function compilation.

**Why this matters (performance numbers):**

| Operation | Time |
|-----------|------|
| vm.Script compile | ~0.3-0.5ms |
| Cache lookup | ~0.001ms |
| **Speedup** | **300-500x** |

**Why LRU (Least Recently Used):**
- Hot functions stay cached (frequently accessed)
- Cold functions get evicted (rarely used)
- Bounded memory (configurable max size)
- Map-based O(1) operations

**Why vm.Script instead of eval():**

| Aspect | eval() | vm.Script |
|--------|--------|-----------|
| Compilation | Re-compiles on string change | Compiles once, reuse Script object |
| Context injection | Requires string manipulation | Native `runInContext()` support |
| V8 code caching | Loses optimization on string change | `produceCachedData: true` enables |
| Performance (cached) | ~1.2-3µs | ~0.08-0.3µs |
| Performance (with context) | ~4.8ms | ~0.1ms |
| Stack traces | Shows "eval" | Shows proper filename |

**Context key optimization:**
Instead of slow `JSON.stringify(context)`, we create a deterministic key:
```js
// Slow: JSON.stringify({ TAX: 0.2, name: "test" })
// Fast: createContextKey() → 'TAX:number:0.2|name:string:test'
```
Uses djb2 hash for objects/functions - ~10x faster than JSON.stringify.

---

### `src/worker.js` - Worker Thread Script

**Purpose:** Code that runs inside worker threads.

**Message protocol:**
```js
// Incoming (from main thread)
{ fn: string, args: any[], context: object }

// Outgoing (to main thread)
{ ok: true, value: any }           // Success
{ ok: false, error: {...} }        // Error
{ type: 'log', level: 'log', args: string[] }  // Console
```

**Why console forwarding:**
Worker threads don't share stdout with main thread. Without forwarding, `console.log` in worker functions would be silent. We intercept all console methods and send via postMessage.

**Why validation caching:**
Function source validation (regex matching) runs on every call. By caching validated sources in a Set, we skip regex matching for repeated functions.

**Curried function support:**
```js
// Both work with usingParams(1, 2, 3):
(a, b, c) => a + b + c    // Normal: fn(1, 2, 3)
a => b => c => a + b + c  // Curried: fn(1)(2)(3)
```
The `applyCurried()` function detects curried returns and applies args sequentially.

---

### `src/generator-worker.js` - Generator Worker

**Purpose:** Specialized worker for streaming generators.

**Why separate from worker.js:**
- Different message protocol (multiple messages vs single response)
- Different execution flow (yield loop vs single return)
- Cleaner separation of concerns

**Message types:**
```js
{ type: 'yield', value }   // Each yield
{ type: 'return', value }  // Generator return value
{ type: 'end' }            // Generator finished
{ type: 'error', error }   // Error occurred
{ type: 'log', level, args }  // Console output
```

---

### `src/errors.js` - Typed Errors

**Purpose:** Custom error classes for specific failure modes.

**Why typed errors:**
1. **instanceof checks:** `if (err instanceof TimeoutError)`
2. **Error codes:** `err.code === 'ERR_TIMEOUT'`
3. **Extra context:** `err.timeout`, `err.maxSize`, etc.
4. **Clear semantics:** Error type tells you exactly what happened

| Error | Code | When |
|-------|------|------|
| `AbortError` | `ERR_ABORTED` | Task cancelled via AbortSignal |
| `TimeoutError` | `ERR_TIMEOUT` | Exceeded time limit |
| `QueueFullError` | `ERR_QUEUE_FULL` | Queue at maxQueueSize |
| `WorkerError` | `ERR_WORKER` | Error thrown inside worker |

---

### `src/validation.js` - Input Validation

**Purpose:** Centralized input validation functions.

**Why separate file:**
- DRY: Same validations used in multiple places
- Testable: Can test validation logic in isolation
- Consistent: Same error messages everywhere

```js
validateFunction(fn)   // Must be function
validateTimeout(ms)    // Must be positive finite number
validatePoolSize(n)    // Must be integer >= 1
```

---

### `src/utils.js` - Utilities

**Purpose:** Generic helper functions.

```js
deepFreeze(obj)      // Recursively freeze (for immutable stats)
sleep(ms)            // Promise-based delay
calculateBackoff()   // Exponential backoff with jitter
```

**Why jitter in backoff:**
Without jitter, if 100 tasks fail at the same time with 100ms backoff, they all retry at exactly 100ms, 200ms, 400ms... causing "thundering herd" spikes.

Jitter adds randomness: `delay * (0.5 + Math.random())` spreads retries across time.

---

### `src/index.d.ts` - TypeScript Types

**Purpose:** Type definitions for TypeScript users.

**Why ship types:**
- Autocomplete in IDEs
- Compile-time type checking
- Self-documenting API
- Required for TypeScript projects

---

## Core Decisions & Rationale

### Why vm.Script over eval()?

**The problem with eval():**
```js
// Every call with different context = new compilation
eval(`(function() { return x * ${TAX} })`); // String changes = no cache
```

**vm.Script solution:**
```js
const script = new vm.Script('(x) => x * TAX');
// Context changes, but Script object is reused
script.runInContext({ TAX: 0.2, ...globals });
script.runInContext({ TAX: 0.3, ...globals }); // Same compiled code!
```

**Benchmarks (1 million executions):**

| Function | eval() | vm.Script | Speedup |
|----------|--------|-----------|---------|
| `x => x * 2` | 182ms | 91ms | 2x |
| `x => x * TAX` (changing context) | 4,821ms | 112ms | **43x** |

### Why worker.unref()?

Workers are created with `worker.unref()` so they don't block process exit.

```js
// Without unref:
// - Script finishes
// - Process hangs waiting for workers to exit
// - User must call shutdown()

// With unref:
// - Script finishes
// - Process exits naturally
// - Workers are cleaned up by OS
```

### Why separate pools for normal/generator?

Different message protocols:
- **Normal:** Single response `{ ok, value }`
- **Generator:** Multiple messages `{ type: 'yield' }`, `{ type: 'end' }`

Mixing them would require complex message routing. Separate pools keep code simple.

### Why least-used load balancing?

Alternatives considered:
1. **Round-robin:** Doesn't account for varying task durations
2. **Random:** Unpredictable, can create hotspots
3. **Least-connections:** Good for servers, overkill here

Least-used (fewest tasks executed) is simple, effective, and naturally distributes load. Workers that get stuck with slow tasks fall behind in count, so they get fewer new tasks.

### Why priority queues?

Real-world needs:
- **High:** Health checks, critical operations
- **Normal:** Regular tasks
- **Low:** Background jobs, analytics

Without priority, a flood of low-priority tasks would starve critical ones.

### Why immutable executors?

```js
// Mutable (dangerous):
const exec = beeThreads.run(fn);
exec.usingParams(1);
exec.usingParams(2); // Overwrites params!

// Immutable (safe):
const exec = beeThreads.run(fn);
const exec1 = exec.usingParams(1);
const exec2 = exec.usingParams(2); // Independent
```

### Why temporary workers?

When pool is full and queue is growing, temporary workers provide burst capacity:
- Created when all pooled workers are busy
- Terminated immediately after task completes
- Limited by `maxTemporaryWorkers` config
- Metrics track their usage

This handles traffic spikes without permanent resource allocation.

---

## Performance Architecture

### Four-Layer Optimization

```
┌────────────────────────────────────────────────────────────────┐
│ Layer 1: vm.Script Compilation                                  │
│ • Compile once, run many times                                 │
│ • produceCachedData enables V8 code caching                    │
│ • 5-15x faster than eval() for context injection               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 2: LRU Function Cache                                     │
│ • Avoid recompilation of repeated functions                    │
│ • Cache key includes context hash                              │
│ • Bounded size prevents memory bloat                           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 3: Worker Affinity                                        │
│ • Route same function to same worker                           │
│ • Leverages V8 TurboFan optimization                          │
│ • Function hash → Worker mapping                               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 4: V8 TurboFan JIT                                        │
│ • Hot functions get compiled to machine code                   │
│ • Affinity ensures functions stay "hot" in same worker         │
│ • Combined effect: near-native performance                     │
└────────────────────────────────────────────────────────────────┘
```

### Metrics Available

```js
const stats = beeThreads.getPoolStats();

// Global metrics
stats.metrics.totalTasksExecuted    // All completed tasks
stats.metrics.totalTasksFailed      // All failed tasks
stats.metrics.totalRetries          // Retry attempts
stats.metrics.affinityHits          // Function routed to cached worker
stats.metrics.affinityMisses        // No cached worker found
stats.metrics.affinityHitRate       // "75.3%"

// Per-worker metrics
stats.normal.workers[0].tasksExecuted      // Tasks this worker ran
stats.normal.workers[0].avgExecutionTime   // Average ms per task
stats.normal.workers[0].cachedFunctions    // Functions in this worker's cache
```

---

## Data Flow

### Normal Task Flow

```
User: beeThreads.run(fn).usingParams(1).execute()
  │
  ├─► executor.js: Build { fnString, args: [1], options: {} }
  │
  ├─► execution.js: executeOnce()
  │     │
  │     ├─► pool.js: requestWorker('normal', fnHash)
  │     │     │
  │     │     ├─► Check affinity (fnHash in worker.functionHashes)
  │     │     ├─► Or get least-used idle worker
  │     │     ├─► Or create new worker
  │     │     └─► Or queue task
  │     │
  │     ├─► worker.postMessage({ fn, args, context })
  │     │
  │     └─► Wait for response
  │
  ├─► worker.js: (inside worker thread)
  │     │
  │     ├─► validateFunctionSource(fn)
  │     ├─► fnCache.getOrCompile(fn, context)
  │     │     │
  │     │     ├─► Cache hit? Return cached function
  │     │     └─► Cache miss? vm.Script compile + cache
  │     │
  │     ├─► applyCurried(compiledFn, args)
  │     └─► parentPort.postMessage({ ok: true, value })
  │
  └─► execution.js: Resolve promise with value
```

### Generator Stream Flow

```
User: beeThreads.stream(genFn).execute()
  │
  ├─► for await (const value of stream) { ... }
  │
  ├─► generator-worker.js:
  │     │
  │     ├─► Compile generator
  │     ├─► for (const value of generator()) {
  │     │     postMessage({ type: 'yield', value })
  │     │   }
  │     └─► postMessage({ type: 'end' })
  │
  └─► stream-executor.js: Convert messages to async iterator
```

---

## Contributing Guide

### Adding a New Executor Method

1. **Update `executor.js`:**
   ```js
   myMethod(options) {
     return createExecutor({
       fnString,
       options: { ...options, myOption: options },
       args
     });
   }
   ```

2. **Update `index.d.ts`** with TypeScript types

3. **Add tests in `test.js`**

4. **Update README if user-facing**

### Running Tests

```bash
npm test
# or
node test.js
```

Current coverage: **169 tests**

### Code Style

- JSDoc on all public functions with `@param`, `@returns`, `@example`
- "Why this exists" comments on modules
- Descriptive names (no abbreviations)
- Small, focused functions (< 50 lines preferred)
- Centralized state in config.js

### Performance Testing

When making changes, benchmark before/after:

```js
const iterations = 100000;
const start = Date.now();
for (let i = 0; i < iterations; i++) {
  await bee(x => x * 2)(i);
}
console.log(`${iterations} iterations: ${Date.now() - start}ms`);
```

---

## License

MIT
