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
// no params
await bee(() => 42)

// with params
await bee((x) => x * 2)(21)

// multiple params
await bee((a, b) => a + b)(10)(20)

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

```js
beeThreads.safeRun(fn)           // never throws, returns { status, value/error }
beeThreads.withTimeout(5000)(fn) // with timeout
beeThreads.stream(generatorFn)   // async iterator from generator
```

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

## License

MIT
