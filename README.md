# 🐝 bee-threads

[![npm](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dw/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/bee-threads)

<div align="center">

### ⚡ THE BEST THREADS DX IN NODE.JS ⚡

**Parallel programming made simple. Zero boilerplate. Zero dependencies.**

</div>

---

## Parallel Programming with bee-threads

```bash
npm install bee-threads
```

```js
const { bee } = require('bee-threads')

// Run any function in a separate thread - promise style
const result = await bee(x => x * 2)(21) // 42

// Run with Promise.all
const [a, b, c] = await Promise.all([bee(x => x * 2)(21), bee(x => x + 1)(41), bee(() => 'hello')()])
```

---

## Native worker_threads vs bee-threads

<table>
<tr>
<th>❌ Native worker_threads</th>
<th>✅ bee-threads</th>
</tr>
<tr>
<td>

```js
// worker.js (separate file!)
const { parentPort } = require('worker_threads')
parentPort.on('message', x => {
	parentPort.postMessage(x * 2)
})

// main.js
const { Worker } = require('worker_threads')
const worker = new Worker('./worker.js')

worker.postMessage(21)

worker.on('message', result => {
	console.log(result) // 42
})

worker.on('error', err => {
	console.error('Worker error:', err)
})

worker.on('exit', code => {
	if (code !== 0) {
		console.error(`Worker stopped: ${code}`)
	}
})

// No pooling, no reuse, no caching...
// 50+ lines of boilerplate
```

</td>
<td>

```js
const { bee } = require('bee-threads')

const result = await bee(x => x * 2)(21)
// 42

// ✅ Worker pool (auto-managed)
// ✅ Function caching (300-500x faster)
// ✅ Worker affinity (V8 JIT benefits)
// ✅ Priority Queues
// ✅ Error handling (try/catch works)
// ✅ TypeScript support
// ✅ Zero dependencies
// ✅ Promise-like syntax
```

</td>
</tr>
</table>

---

## Basic Usage

```js
// Simple
await bee(() => 42)()

// With arguments
await bee((a, b) => a + b)(10, 20) // → 30

// External variables (closures)
const TAX = 0.2
await bee(price => price * (1 + TAX))(100, { beeClosures: { TAX } }) // → 120
```

---

## Full API

For more control, use `beeThreads`:

```js
const { beeThreads } = require('bee-threads')

await beeThreads
	.run(x => x * 2)
	.usingParams(21)
	.execute() // → 42
```

### `.usingParams(...args)`

```js
await beeThreads
	.run((a, b) => a + b)
	.usingParams(10, 20)
	.execute() // → 30
```

### `.setContext({ vars })`

Inject external variables (closures):

```js
const TAX = 0.2
await beeThreads
	.run(p => p * (1 + TAX))
	.usingParams(100)
	.setContext({ TAX })
	.execute() // → 120
```

### `.signal(AbortSignal)` - Cancellation

Cancel long-running tasks from the outside:

```js
const controller = new AbortController()

// Start a heavy computation
const promise = beeThreads
	.run(() => {
		let sum = 0
		for (let i = 0; i < 1e10; i++) sum += i
		return sum
	})
	.signal(controller.signal)
	.execute()

// User clicks "Cancel" button
cancelButton.onclick = () => controller.abort()
```

### `.retry(options)` - Auto-retry with Backoff

Retry failed tasks with exponential backoff:

```js
const data = await beeThreads
	.run(() => fetchFromFlakyAPI())
	.retry({
		maxAttempts: 5, // Try up to 5 times
		baseDelay: 100, // Start with 100ms delay
		maxDelay: 5000, // Cap at 5 seconds
		backoffFactor: 2, // Double delay each retry: 100 → 200 → 400 → 800...
	})
	.execute()
```

### `.priority('high' | 'normal' | 'low')`

Control execution order when workers are busy:

```js
// Payment processing - jump the queue
await beeThreads
	.run(() => processPayment())
	.priority('high')
	.execute()

// Report generation - can wait
await beeThreads
	.run(() => generateReport())
	.priority('low')
	.execute()
```

### `.transfer([...buffers])` - Zero-copy Transfer

Move large binary data to worker without copying:

```js
// Process 10MB image - transferred instantly, not copied
const imageBuffer = new ArrayBuffer(10 * 1024 * 1024)

await beeThreads
	.run(buf => processImage(buf))
	.usingParams(imageBuffer)
	.transfer([imageBuffer.buffer])
	.execute()

// Note: imageBuffer is now empty (ownership moved to worker)
```

```js
const image = new Uint8Array(pixels)
const mask = new Uint8Array(maskData)
const options = { width: 800, quality: 90 }

await beeThreads
	.run((img, msk, opts) => processImage(img, msk, opts, SHARP_OPTIONS))
	.usingParams(image, mask, options)
	.setContext({ SHARP_OPTIONS: { fit: 'cover' } })
	.transfer([image.buffer, mask.buffer])
	.execute()
```

### `.reconstructBuffers()` - Buffer Reconstruction

When using libraries like **Sharp**, **fs**, or **crypto** that return `Buffer`, the result gets converted to `Uint8Array` by `postMessage`. Use `.reconstructBuffers()` to convert them back:

```js
// Without reconstructBuffers() - returns Uint8Array
const uint8 = await beeThreads.run(() => require('fs').readFileSync('file.txt')).execute()
console.log(Buffer.isBuffer(uint8)) // false (Uint8Array)

// With reconstructBuffers() - returns Buffer
const buffer = await beeThreads
	.run(() => require('fs').readFileSync('file.txt'))
	.reconstructBuffers()
	.execute()
console.log(Buffer.isBuffer(buffer)) // true ✅
```

Works with **Sharp** for image processing:

```js
const resized = await beeThreads
	.run(img => require('sharp')(img).resize(100, 100).toBuffer())
	.usingParams(imageBuffer)
	.transfer([imageBuffer.buffer])
	.reconstructBuffers()
	.execute()

console.log(Buffer.isBuffer(resized)) // true ✅
```

Also works with **generators**:

```js
const stream = beeThreads
	.stream(function* () {
		yield require('fs').readFileSync('chunk1.bin')
		yield require('fs').readFileSync('chunk2.bin')
	})
	.reconstructBuffers()
	.execute()

for await (const chunk of stream) {
	console.log(Buffer.isBuffer(chunk)) // true ✅
}
```

---

## ⚡ Turbo Mode - Parallel Array Processing

Process large arrays across **ALL CPU cores** with **fail-fast** error handling.

> ✅ **Async (Non-blocking):** Main thread stays free for handling requests/events

```
┌───────────────────────────────────────────────────────────────────────┐
│  beeThreads.turbo([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map(fn)   │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │         SPLIT INTO BATCHES              │
        │    (auto-calculated per worker)         │
        └─────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
   │  Worker 1   │     │  Worker 2   │     │  Worker 3   │
   │ [1,2,3,4]   │     │ [5,6,7,8]   │     │ [9,10,11,12]│
   │  fn(item)   │     │  fn(item)   │     │  fn(item)   │
   └─────────────┘     └─────────────┘     └─────────────┘
          │                   │                   │
          │              ❌ ERROR!                │
          │                   │                   │
          ▼                   ▼                   ▼
   ┌─────────────────────────────────────────────────────┐
   │  FAIL-FAST: All workers abort, Promise rejects     │
   │  Resources cleaned up, error propagated to caller  │
   └─────────────────────────────────────────────────────┘
```

### Usage

```js
// Map
const squares = await beeThreads.turbo(numbers).map(x => x * x)

// Filter
const evens = await beeThreads.turbo(numbers).filter(x => x % 2 === 0)

// Reduce
const sum = await beeThreads.turbo(numbers).reduce((a, b) => a + b, 0)

// TypedArray (SharedArrayBuffer - zero-copy!)
const pixels = new Float64Array(1_000_000)
const bright = await beeThreads.turbo(pixels).map(x => Math.min(255, x * 1.2))

// With context
const factor = 2.5
await beeThreads.turbo(data, { context: { factor } }).map(x => x * factor)

// With stats
const { data, stats } = await beeThreads.turbo(arr).mapWithStats(x => x * x)
console.log(stats.speedupRatio) // "7.2x"
```

## Request Coalescing

Prevents duplicate simultaneous calls from running multiple times. When the same function with identical arguments is called while a previous call is in-flight, subsequent calls share the same Promise.

```js
// All 3 calls share ONE execution, return same result
const [r1, r2, r3] = await Promise.all([bee(x => expensiveComputation(x))(42), bee(x => expensiveComputation(x))(42), bee(x => expensiveComputation(x))(42)])

// Control coalescing
beeThreads.setCoalescing(false) // disable globally
beeThreads.getCoalescingStats() // { coalesced: 15, unique: 100, coalescingRate: '13%' }

// Opt-out for specific execution
await beeThreads
	.run(() => Date.now())
	.noCoalesce()
	.execute()
```

**Auto-detection:** Functions with `Date.now()`, `Math.random()`, `crypto.randomUUID()` are automatically excluded.

---

## Generators (Streaming)

Stream results as they're produced instead of waiting for all:

```js
const stream = beeThreads
	.stream(function* (n) {
		for (let i = 1; i <= n; i++) {
			yield i * i // Streamed immediately
		}
		return 'done' // Captured in stream.returnValue
	})
	.usingParams(5)
	.execute()

for await (const value of stream) {
	console.log(value) // 1, 4, 9, 16, 25
}
console.log(stream.returnValue) // 'done'
```

---

## Error Handling

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads')

try {
	await beeThreads.run(fn).execute()
} catch (err) {
	if (err instanceof TimeoutError) {
		/* timeout */
	}
	if (err instanceof AbortError) {
		/* cancelled */
	}
	if (err instanceof QueueFullError) {
		/* queue full */
	}
	if (err instanceof WorkerError) {
		// Custom error properties preserved
		console.log(err.code, err.statusCode)
	}
}

// Safe mode - never throws, returns result object
const result = await beeThreads.run(fn).safe().execute()
if (result.status === 'fulfilled') {
	console.log(result.value)
} else {
	console.log(result.error)
}
```

---

## Configuration

```js
beeThreads.configure({
	poolSize: 8, // Max workers (default: CPU cores)
	minThreads: 2, // Pre-warmed workers
	maxQueueSize: 1000, // Max pending tasks
	workerIdleTimeout: 30000, // Cleanup idle workers (ms)
	debugMode: true, // Show function source in errors
	logger: console, // Custom logger (or null)
	lowMemoryMode: false, // Reduce memory (~60-80% less)
	coalescing: true, // Request coalescing (default: true)
})

await beeThreads.warmup(4) // Pre-warm 4 workers
const stats = beeThreads.getPoolStats() // Metrics
await beeThreads.shutdown() // Graceful shutdown
```

---

## TypeScript

Full type inference:

```ts
import { bee, beeThreads, TimeoutError, WorkerError } from 'bee-threads'

const result = await bee((x: number) => x * 2)(21) // number

const stream = beeThreads
	.stream(function* (n: number) {
		yield n * 2
	})
	.usingParams(5)
	.execute() // StreamResult<number>
```

---

## Limitations

-  **No `this` binding** - Use arrow functions or `.setContext()`
-  **No closures** - External vars via `beeClosures` or `.setContext()`
-  **Serializable only** - No functions, Symbols, or circular refs in args/return

---

## Worker Environment

| API                      | Status                   |
| ------------------------ | ------------------------ |
| `require()`              | ✅ Works                 |
| `Buffer`                 | ✅ Works                 |
| `URL`, `URLSearchParams` | ✅ Works                 |
| `TextEncoder/Decoder`    | ✅ Works                 |
| `crypto`                 | ✅ Works                 |
| `Intl`                   | ✅ Works                 |
| `AbortController`        | ❌ Use signal externally |
| `structuredClone`        | ❌ Not available         |
| `performance.now()`      | ❌ Use `Date.now()`      |

---

## Use Cases

- Password hashing (PBKDF2, bcrypt)
- Image processing (sharp, jimp)
- Large JSON parsing
- Data compression
- PDF generation
- Heavy computations
- **Large array processing** (turbo mode)
- **Matrix operations** (turbo mode)
- **Numerical simulations** (turbo mode)
- Data pipelines
- Video/image encoding services
- Scientific computing

---

## Benchmarks

Run the benchmark yourself:

```bash
bun benchmarks.js   # Bun
node benchmarks.js  # Node
```

### Results (1M items, heavy function, 12 CPUs, 10 runs avg)

**Bun** - Real parallel speedup:

| Mode | Time (±std) | Speedup | Main Thread |
|------|-------------|---------|-------------|
| main | 285±5ms | 1.00x | ❌ blocked |
| bee | 1138±51ms | 0.25x | ✅ free |
| turbo(4) | 255±7ms | 1.12x | ✅ free |
| turbo(8) | 180±8ms | **1.58x** | ✅ free |
| **turbo(12)** | **156±12ms** | **1.83x** | ✅ free |
| turbo(16) | 204±28ms | 1.40x | ✅ free |

**Node** - Non-blocking I/O (slower, but frees main thread):

| Mode | Time (±std) | Speedup | Main Thread |
|------|-------------|---------|-------------|
| main | 368±13ms | 1.00x | ❌ blocked |
| bee | 5569±203ms | 0.07x | ✅ free |
| turbo(4) | 1793±85ms | 0.21x | ✅ free |
| turbo(8) | 1052±22ms | 0.35x | ✅ free |
| **turbo(12)** | **1017±57ms** | **0.36x** | ✅ free |
| turbo(16) | 1099±98ms | 0.34x | ✅ free |

### Key Insights

- **Bun + turbo(cpus)**: Up to **1.83x faster** than main thread
- **bee/turbo**: Non-blocking - main thread stays **free for HTTP/I/O**
- **Node + turbo**: Slower, but useful for keeping servers responsive
- **bee vs turbo**: turbo is **7x faster** than bee for large arrays
- **Default workers**: `cpus - 1` (safe for all systems)

### Customize Workers

```js
// Method chain
await beeThreads.turbo(data).setWorkers(12).map(fn)

// Or via options
await beeThreads.turbo(data, { workers: 12 }).map(fn)
```

### When to Use

| Scenario | Recommendation |
|----------|----------------|
| Bun + heavy function | `turbo(cpus)` → real speedup |
| Node + HTTP server | `turbo()` → non-blocking I/O |
| Light function (`x*x`) | Main thread → overhead not worth it |
| CLI/batch processing | `turbo(cpus + 4)` → max throughput |

---

## Why bee-threads?

- **Zero dependencies** - Lightweight and secure
- **Inline functions** - No separate worker files
- **Worker pool** - Reuses threads, no cold-start
- **Function caching** - LRU cache, 300-500x faster
- **Worker affinity** - Same function → same worker (V8 JIT)
- **Request coalescing** - Deduplicates identical calls
- **Turbo mode** - Parallel array processing (workers only)
- **Full TypeScript** - Complete type definitions

---

MIT © [Samuel Santos](https://github.com/samsantosb)
