# async-threads

> Run **synchronous blocking code** as `await`able Promises using Node.js Worker Threads. Zero boilerplate. **Curried API**.

## Why?

Node.js is single-threaded. Heavy synchronous operations (crypto, JSON parsing, image processing) block the event loop and freeze your server.

**async-threads** moves any function to a worker thread and returns a Promise—turn blocking code into non-blocking with one line.

```js
// Before: blocks the event loop for ~500ms
const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');

// After: runs in background, event loop stays free
const hash = await asyncThread.run(
  (pw, s) => require('crypto').pbkdf2Sync(pw, s, 100000, 64, 'sha512')
)(password, salt);
```

## Installation

```bash
npm install async-threads
```

## Quick Start

```js
const { asyncThread } = require('async-threads');

// Curried API: first call takes the function, second takes the arguments
const result = await asyncThread.run((a, b) => {
  // This runs in a separate thread!
  let sum = 0;
  for (let i = a; i < b; i++) sum += i;
  return sum;
})(0, 1_000_000);

console.log(result); // 499999500000
```

### Reusable Workers

The curried API makes it easy to create reusable worker functions:

```js
// Create once
const heavyCompute = asyncThread.run((data) => {
  // Complex CPU-bound operation
  return processData(data);
});

// Use multiple times
const result1 = await heavyCompute(dataset1);
const result2 = await heavyCompute(dataset2);
const result3 = await heavyCompute(dataset3);
```

### Fire and Forget (Background)

Run tasks in background without waiting. **Always add `.catch()`** to avoid unhandled promise rejections:

```js
// ❌ BAD: Unhandled promise rejection if it fails
asyncThread.run(() => sendAnalytics(data))();

// ✅ GOOD: Fire and forget with error handling
asyncThread.run(() => sendAnalytics(data))()
  .catch(console.error);

// ✅ GOOD: With custom error handler
asyncThread.run(() => syncToCloud(backup))()
  .catch(err => logger.warn('Background sync failed:', err));

// ✅ GOOD: Use safeRun to never throw (no .catch needed)
asyncThread.safeRun(() => optionalTask())();
```

**Tip:** For truly optional background tasks where you don't care about errors, use `safeRun` — it never rejects.

## API

### `asyncThread.run(fn)(...args)`

Curried function. First call takes the function, second call takes arguments and returns a Promise.

```js
// Inline
const data = await asyncThread.run(() => JSON.parse(hugeJsonString))();

// Or store for reuse
const parseJSON = asyncThread.run((str) => JSON.parse(str));
const obj = await parseJSON(jsonString);
```

### `asyncThread.safeRun(fn)(...args)`

Same as `run`, but **never rejects**. Always returns an object:

```js
const result = await asyncThread.safeRun(() => JSON.parse(invalid))();

if (result.status === 'fulfilled') {
  console.log(result.value);
} else {
  console.error(result.error); // Error object
}
```

### `asyncThread.withTimeout(ms)(fn)(...args)`

Returns a curried runner that rejects if execution exceeds `ms` milliseconds.

```js
const fastRun = asyncThread.withTimeout(1000);

try {
  await fastRun(() => {
    while (true); // infinite loop
  })();
} catch (e) {
  console.log(e.message); // "Worker timed out after 1000ms"
}
```

### `asyncThread.safeWithTimeout(ms)(fn)(...args)`

Combines `safeRun` with a timeout—never rejects, returns `{ status, value/error }`.

```js
const safeFast = asyncThread.safeWithTimeout(500);
const result = await safeFast(() => slowOperation())();

if (result.status === 'rejected') {
  console.log('Timed out or errored:', result.error.message);
}
```

### `asyncThread.stream(generatorFn)(...args)`

Runs a **generator function** in a worker and returns a `ReadableStream`. Each `yield` becomes a stream chunk.

```js
const stream = asyncThread.stream(function* (start, end) {
  for (let i = start; i <= end; i++) {
    yield i * i; // Each yield = one chunk
  }
})(1, 5);

for await (const chunk of stream) {
  console.log(chunk); // 1, 4, 9, 16, 25 (squares of 1-5)
}
```

Supports async yields:

```js
const stream = asyncThread.stream(function* () {
  yield fetch('https://api.example.com/1').then(r => r.json());
  yield fetch('https://api.example.com/2').then(r => r.json());
})();
```

### `asyncThread.setPoolSize(n)`

Configure the worker pool size (default: `CPU cores - 1`).

```js
asyncThread.setPoolSize(4); // Use 4 workers max
```

### `asyncThread.shutdown()`

Terminate all pooled workers. Call this for graceful shutdown.

```js
process.on('SIGTERM', async () => {
  await asyncThread.shutdown();
  process.exit(0);
});
```

### `asyncThread.getPoolStats()`

Get pool statistics for monitoring.

```js
const stats = asyncThread.getPoolStats();
console.log(stats);
// { size: 3, maxSize: 7, busy: 2, idle: 1 }
```

### Cancellation with AbortSignal

Cancel running tasks using the standard `AbortController` API:

```js
const controller = new AbortController();

// Start a long-running task
const task = asyncThread.run(() => {
  // CPU-intensive work...
  return result;
}).signal(controller.signal)();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  const result = await task;
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('Task was cancelled');
  }
}
```

The fluent API supports chaining:

```js
// Combine signal with transfer
await asyncThread.run(processBuffer)
  .signal(controller.signal)
  .transfer([buffer])(buffer);

// Check if already aborted before starting
controller.abort('User cancelled');
await asyncThread.run(fn).signal(controller.signal)(); 
// → Throws immediately with AbortError
```

## TypeScript

Full type definitions with complete generic inference:

```ts
import { asyncThread } from 'async-threads';

// Types are fully inferred
const add = asyncThread.run((a: number, b: number) => a + b);
const sum: number = await add(1, 2);

// Safe run returns discriminated union
const result = await asyncThread.safeRun((x: string) => JSON.parse(x))(data);

if (result.status === 'fulfilled') {
  result.value; // typed as `any` (JSON.parse return type)
} else {
  result.error; // typed as `Error`
}

// Stream types
const stream = asyncThread.stream(function* (n: number) {
  for (let i = 0; i < n; i++) yield i;
})(10);
// stream is ReadableStream<number>
```

### Exported Types

```ts
import { asyncThread, AbortError } from 'async-threads';

import type {
  AsyncThread,
  ThreadResult,
  FulfilledResult,
  RejectedResult,
  PoolStats,
  Executor,
  SafeExecutor,
  ExecutionOptions,
} from 'async-threads';
```

## Security

This library includes several security measures:

- **Input validation**: All inputs are validated before execution
  - Functions are validated at curry-time (fail fast)
  - Timeout values must be positive finite numbers
  - Pool size must be a positive integer
- **Function source validation**: Workers validate that the received string looks like a valid function before `eval()`
- **Pool size enforcement**: Workers are limited to `poolSize` - excess requests use temporary workers that are terminated after use
- **Memory leak prevention**: Event listeners are properly removed when workers are reused
- **Graceful shutdown**: `shutdown()` method to cleanly terminate all workers

### ⚠️ Security Considerations

This library uses `eval()` internally to execute serialized functions. This is **safe** when:
- You control all the functions being passed
- Functions come from your own codebase

**Never** pass user-provided strings as functions. The library validates function patterns, but this is defense-in-depth, not a security boundary.

## ⚠️ Critical: Closures Don't Work

**This is a fundamental limitation of worker_threads serialization.**

Functions are converted to strings via `.toString()` and executed in an isolated context. They **cannot** access outer scope variables:

```js
const API_KEY = 'secret123';
const multiplier = 10;
const config = { retries: 3 };

// ❌ ALL OF THESE WILL FAIL - outer variables are undefined in worker
await asyncThread.run(() => fetch(API_KEY))();           // API_KEY is undefined
await asyncThread.run(() => 5 * multiplier)();          // multiplier is undefined  
await asyncThread.run(() => config.retries)();          // config is undefined

// ✅ SOLUTION: Pass everything as arguments
await asyncThread.run((key) => fetch(key))(API_KEY);
await asyncThread.run((m) => 5 * m)(multiplier);
await asyncThread.run((cfg) => cfg.retries)(config);

// ✅ Or use require() inside the function (creates new instance)
await asyncThread.run(() => {
  const crypto = require('crypto');
  return crypto.randomBytes(16).toString('hex');
})();
```

**Rule of thumb:** If your function references ANY variable defined outside its body, it won't work. Pass it as an argument instead.

## Advanced Features

### Zero-Copy Transfer (ArrayBuffer)

For large binary data, use `.transfer()` to avoid copying:

```js
const buffer = new ArrayBuffer(1024 * 1024); // 1MB

// Without transfer: buffer is COPIED (slow for large buffers)
await asyncThread.run((buf) => process(buf))(buffer);

// With transfer: buffer is MOVED (zero-copy, original becomes detached)
await asyncThread.run((buf) => process(buf)).transfer([buffer])(buffer);
```

### Generator Return Values

Access the final `return` value from generators:

```js
const stream = asyncThread.stream(function* () {
  yield 1;
  yield 2;
  return 'done'; // This is captured
})();

for await (const chunk of stream) {
  console.log(chunk); // 1, 2
}

console.log(stream.returnValue); // 'done'
```

## Important Notes

1. **Functions must be pure** — no closures, no outer scope access (see warning above)

2. **Arguments must be serializable** — only values that can pass through `postMessage`:
   - ✅ Primitives, plain objects, arrays, Date, RegExp, Map, Set, ArrayBuffer
   - ❌ Functions, Symbols, WeakMap/WeakSet, circular references, class instances

3. **Node.js only** — requires `worker_threads` module (Node.js 14.18.0+)

4. **Type safety** — pass a non-function and get `TypeError` immediately

5. **Stats are immutable** — `getPoolStats()` returns a frozen object

## Use Cases

- CPU-intensive calculations
- Synchronous crypto operations (`pbkdf2Sync`, `scryptSync`)
- Large JSON parsing/stringifying
- Image processing with sync libraries
- File compression/decompression
- Any blocking operation you want to offload

## License

MIT
