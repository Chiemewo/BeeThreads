# 🐝 bee-threads

[![npm version](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dm/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![license](https://img.shields.io/npm/l/bee-threads.svg)](https://github.com/samsantosb/BeeThreads/blob/main/LICENSE)

> Run sync code in worker threads with a simple await.

```js
const { beeThreads } = require('bee-threads');

const hash = await beeThreads
  .run((pwd) => require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex'))
  .usingParams('password')
  .execute();
```

**Short syntax:**

```js
const { bee } = require('bee-threads');

const hash = await bee(
  (pwd) => require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex')
)('password');
```

## Install

```bash
npm install bee-threads
```

---

## `bee` — Short Syntax

```js
// no params (always requires empty call)
await bee(() => 42)()

// params together
await bee((a, b, c) => a + b + c)(1, 2, 3)

// curry style
await bee((a, b, c) => a + b + c)(1)(2)(3)

// with external variables
const TAX = 0.2;
await bee((price) => price * (1 + TAX))(100)({ beeClosures: { TAX } })
```

---

## `beeThreads` — Full API

```js
await beeThreads.run(fn).execute()
await beeThreads.run(fn).usingParams(args).execute()
await beeThreads.run(fn).usingParams(args).setContext({ VAR }).execute()
```

### Methods

| Method | Description |
|--------|-------------|
| `.usingParams(...args)` | Pass arguments |
| `.setContext(obj)` | Inject external variables |
| `.signal(AbortSignal)` | Cancellation |
| `.transfer([ArrayBuffer])` | Zero-copy transfer |
| `.retry({ attempts })` | Auto-retry |
| `.priority('high'\|'low')` | Queue priority |
| `.execute()` | Run |

### Variants

| Method | Description |
|--------|-------------|
| `beeThreads.run(fn)` | Normal execution |
| `beeThreads.safeRun(fn)` | Never throws — returns `{ status, value/error }` like `Promise.allSettled` |
| `beeThreads.withTimeout(ms)(fn)` | Execution with timeout |
| `beeThreads.stream(generatorFn)` | Async iterator from generator |

---

## Pool

```js
beeThreads.configure({ poolSize: 8, minThreads: 2 });
await beeThreads.warmup(4);   // pre-create workers
await beeThreads.shutdown();  // terminate all
beeThreads.getPoolStats();    // metrics
```

---

## Errors

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads');
```

---

## Use Cases

1. **Password Hashing** — PBKDF2, bcrypt, scrypt
2. **Image Processing** — resize, compress, filters (sharp, jimp)
3. **Large JSON Parsing** — 50MB+ JSON files
4. **Data Compression** — gzip, brotli, zstd
5. **Complex Regex** — pattern matching on large text
6. **PDF Generation** — multi-page documents
7. **Batch Validation** — validate thousands of records

---

## Why bee-threads?

**Developer Experience:**

- **Inline functions** — no separate worker files
- **Simple syntax** — `await bee(fn)(args)` 
- **Closure support** — pass external variables with `beeClosures`
- **Full TypeScript** — complete type definitions
- **Zero config** — works out of the box

**Performance:**

- **Worker pool** — reuses threads, no cold-start
- **Load balancing** — distributes tasks across workers
- **Priority queue** — critical tasks first
- **Auto-retry** — handles transient failures

**Production Ready:**

- **Non-blocking shutdown** — `worker.unref()` doesn't hold process
- **Console forwarding** — logs from workers appear in main thread
- **Graceful degradation** — queue overflow handling

## License

MIT
