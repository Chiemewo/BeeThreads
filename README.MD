# 🐝 bee-threads

[![npm version](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dm/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![license](https://img.shields.io/npm/l/bee-threads.svg)](https://github.com/samsantosb/BeeThreads/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-BeeThreads-blue?logo=github)](https://github.com/samsantosb/BeeThreads)

> **Handle threading as promises.**

Run CPU-intensive JavaScript in worker threads. No separate files, just inline functions.

```js
const { bee } = require('bee-threads');

// Hash password without blocking the event loop
const hash = await bee((password) => {
  const crypto = require('crypto');
  return crypto.pbkdf2Sync(password, 'salt', 100000, 64, 'sha512').toString('hex');
})('user-password');
```

## Install

```bash
npm install bee-threads
```

## Two APIs

bee-threads provides two ways to use it:

| API | Best for | Syntax |
|-----|----------|--------|
| `bee` | Simple tasks, quick scripts | `await bee(fn)(args)` |
| `beeThreads` | Advanced features, full control | `await beeThreads.run(fn).usingParams(args).execute()` |

---

## `bee` — Simple API

Curried function. Clean and minimal.

```js
const { bee } = require('bee-threads');
```

### Basic Usage

```js
// No arguments
await bee(() => 1 + 1)()

// With arguments
await bee((a, b) => a + b)(10, 20)

// With options (last argument)
await bee((x) => x * TAX)(100, { context: { TAX: 0.2 } })
```

### Options

Pass options as the **last argument**:

```js
await bee(fn)(arg1, arg2, {
  context: { VAR: 123 },     // Inject variables
  timeout: 5000,             // Timeout (ms)
  signal: ctrl.signal,       // AbortSignal
  priority: 'high',          // 'high' | 'normal' | 'low'
  safe: true,                // Never throws
  retry: { attempts: 3 }     // Auto-retry
})
```

### Examples

```js
// Double a number
const result = await bee(x => x * 2)(21)
// → 42

// External variables with context
const TAX = 0.2;
const price = await bee(p => p * (1 + TAX))(100, { context: { TAX } })
// → 120

// With timeout
const data = await bee(heavyTask)(input, { timeout: 5000 })

// Safe mode - never throws
const result = await bee(() => JSON.parse('bad'))({ safe: true })
if (result.status === 'rejected') {
  console.error(result.error)
}

// Hash password
const hash = await bee((pwd) => {
  const crypto = require('crypto');
  return crypto.pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex');
})('secret123')
```

---

## `beeThreads` — Full API

Fluent builder pattern. Maximum control.

```js
const { beeThreads } = require('bee-threads');
```

### Basic Usage

```js
await beeThreads
  .run((a, b) => a + b)
  .usingParams(10, 20)
  .execute()
// → 30
```

### All Methods

```js
await beeThreads
  .run(fn)                    // Function to execute
  .usingParams(arg1, arg2)    // Arguments
  .setContext({ VAR: 123 })   // Inject variables
  .signal(ctrl.signal)        // Cancellation
  .transfer([buffer])         // Zero-copy transfer
  .retry({ attempts: 3 })     // Auto-retry
  .priority('high')           // Queue priority
  .execute()                  // Run!
```

### Safe Mode

```js
const result = await beeThreads
  .safeRun(() => JSON.parse('invalid'))
  .execute()

if (result.status === 'rejected') {
  console.error(result.error)
}
```

### Timeout

```js
await beeThreads
  .withTimeout(5000)(heavyTask)
  .usingParams(data)
  .execute()
```

### Streaming (Generators)

```js
const stream = beeThreads
  .stream(function* (n) {
    for (let i = 0; i < n; i++) yield i * i;
  })
  .usingParams(5)
  .execute()

for await (const v of stream) {
  console.log(v)
}
// → 0, 1, 4, 9, 16
```

### Priority

```js
// Critical tasks first
await beeThreads.run(urgentTask).priority('high').execute()

// Background tasks last
await beeThreads.run(lowTask).priority('low').execute()
```

---

## Pool Configuration

```js
beeThreads.configure({
  poolSize: 8,              // Max workers
  minThreads: 2,            // Always-ready workers  
  maxQueueSize: 500,        // Queue limit
  workerIdleTimeout: 60000  // Idle cleanup (ms)
})

// Pre-warm workers (eliminates cold-start)
await beeThreads.warmup(4)

// Graceful shutdown
await beeThreads.shutdown()

// Get metrics
const stats = beeThreads.getPoolStats()
```

---

## Errors

```js
const { 
  TimeoutError,    // Task exceeded timeout
  AbortError,      // Task was cancelled
  QueueFullError,  // Queue at capacity
  WorkerError      // Worker crashed
} = require('bee-threads');
```

---

## Use Cases

### ✅ When to Use

| Task | Why |
|------|-----|
| Password hashing (PBKDF2, bcrypt) | CPU-intensive, blocks event loop |
| Image processing (sharp, jimp) | CPU-intensive |
| Large JSON parsing (50MB+) | Blocks event loop |
| Data compression (gzip, brotli) | CPU-intensive |
| Complex regex on large text | Can take seconds |
| PDF generation | CPU + memory intensive |
| Batch validation | Parallelize across cores |

### ❌ When NOT to Use

| Task | Why |
|------|-----|
| `fetch()` / HTTP | Already async (I/O) |
| Database queries | Already async (I/O) |
| `fs.readFile` | Already async (I/O) |
| Fast operations (<10ms) | Overhead > benefit |

**Rule of thumb:** If it blocks for >50ms, use bee-threads.

---

## Quick Comparison

```js
// bee — Simple, clean
const hash = await bee(hashFn)(password)

// beeThreads — Full control
const hash = await beeThreads
  .run(hashFn)
  .usingParams(password)
  .retry({ attempts: 3 })
  .timeout(5000)
  .execute()
```

Choose `bee` for quick tasks, `beeThreads` when you need advanced features.

## License

MIT © [samsantosb](https://github.com/samsantosb)
