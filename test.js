// test.js - bee-threads test suite
const assert = require('assert');
const { beeThreads, AbortError, TimeoutError, QueueFullError, WorkerError } = require('./src/index.js');

// Test utilities
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    if (err.stack) console.log(`     ${err.stack.split('\n')[1]}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n📦 ${name}`);
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  console.log('\n🧪 bee-threads Test Suite\n');
  console.log('='.repeat(50));

  // ---------- BASIC RUN ----------
  section('beeThreads.run()');

  await test('executes sync function and returns result', async () => {
    const result = await beeThreads
      .run((a, b) => a + b)
      .usingParams(2, 3)
      .execute();
    assert.strictEqual(result, 5);
  });

  await test('handles complex computation', async () => {
    const result = await beeThreads
      .run((n) => {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += i;
        return sum;
      })
      .usingParams(100)
      .execute();
    assert.strictEqual(result, 4950);
  });

  await test('handles async functions (promises)', async () => {
    const result = await beeThreads
      .run(() => Promise.resolve(42))
      .usingParams()
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('rejects on error', async () => {
    await assert.rejects(
      beeThreads.run(() => { throw new Error('test error'); }).usingParams().execute(),
      { message: 'test error' }
    );
  });

  await test('preserves error name', async () => {
    try {
      await beeThreads
        .run(() => {
          const err = new TypeError('type error');
          throw err;
        })
        .usingParams()
        .execute();
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.name, 'TypeError');
    }
  });

  await test('passes multiple arguments correctly', async () => {
    const result = await beeThreads
      .run((a, b, c, d) => a * b + c - d)
      .usingParams(2, 3, 10, 4)
      .execute();
    assert.strictEqual(result, 12);
  });

  await test('handles arrow functions', async () => {
    const result = await beeThreads
      .run((x) => x * 2)
      .usingParams(21)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('handles async arrow functions', async () => {
    const result = await beeThreads
      .run(async (x) => {
        await new Promise(r => setTimeout(r, 10));
        return x * 2;
      })
      .usingParams(21)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('handles curried functions automatically', async () => {
    const result = await beeThreads
      .run((a) => (b) => (c) => a + b + c)
      .usingParams(1, 2, 3)
      .execute();
    assert.strictEqual(result, 6);
  });

  // ---------- SAFE RUN ----------
  section('beeThreads.safeRun()');

  await test('returns fulfilled result on success', async () => {
    const result = await beeThreads
      .safeRun((x) => x * 2)
      .usingParams(21)
      .execute();
    assert.strictEqual(result.status, 'fulfilled');
    assert.strictEqual(result.value, 42);
  });

  await test('returns rejected result on error (never throws)', async () => {
    const result = await beeThreads
      .safeRun(() => { throw new Error('safe error'); })
      .usingParams()
      .execute();
    assert.strictEqual(result.status, 'rejected');
    assert.strictEqual(result.error.message, 'safe error');
  });

  await test('handles async rejection safely', async () => {
    const result = await beeThreads
      .safeRun(async () => { throw new Error('async safe'); })
      .usingParams()
      .execute();
    assert.strictEqual(result.status, 'rejected');
  });

  // ---------- TIMEOUT ----------
  section('beeThreads.withTimeout()');

  await test('completes before timeout', async () => {
    const result = await beeThreads
      .withTimeout(5000)((x) => x + 1)
      .usingParams(41)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('rejects on timeout', async () => {
    await assert.rejects(
      beeThreads
        .withTimeout(50)(() => {
          const start = Date.now();
          while (Date.now() - start < 200) {}
          return 'done';
        })
        .usingParams()
        .execute(),
      TimeoutError
    );
  });

  // ---------- SAFE WITH TIMEOUT ----------
  section('beeThreads.safeWithTimeout()');

  await beeThreads.shutdown();

  await test('returns fulfilled on success within timeout', async () => {
    const result = await beeThreads
      .safeWithTimeout(5000)((x) => x)
      .usingParams(42)
      .execute();
    assert.strictEqual(result.status, 'fulfilled');
    assert.strictEqual(result.value, 42);
  });

  await test('returns rejected on timeout (never throws)', async () => {
    const result = await beeThreads
      .safeWithTimeout(50)(() => {
        const start = Date.now();
        while (Date.now() - start < 200) {}
      })
      .usingParams()
      .execute();
    assert.strictEqual(result.status, 'rejected');
    assert.ok(result.error instanceof TimeoutError);
  });

  await beeThreads.shutdown();

  // ---------- STREAM ----------
  section('beeThreads.stream()');

  await test('streams generator yields', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 1;
        yield 2;
        yield 3;
      })
      .usingParams()
      .execute();

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, [1, 2, 3]);
  });

  await test('streams with arguments', async () => {
    const stream = beeThreads
      .stream(function* (start, count) {
        for (let i = 0; i < count; i++) {
          yield start + i;
        }
      })
      .usingParams(10, 3)
      .execute();

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, [10, 11, 12]);
  });

  await test('handles async yields in generator', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield Promise.resolve(1);
        yield Promise.resolve(2);
      })
      .usingParams()
      .execute();

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, [1, 2]);
  });

  await test('captures generator return value', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 1;
        yield 2;
        return 'final';
      })
      .usingParams()
      .execute();

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, [1, 2]);
    assert.strictEqual(stream.returnValue, 'final');
  });

  await beeThreads.shutdown();

  // ---------- INPUT VALIDATION ----------
  section('Input Validation');

  await test('run() throws TypeError for non-function', () => {
    assert.throws(
      () => beeThreads.run('not a function'),
      TypeError
    );
  });

  await test('run() throws TypeError for null', () => {
    assert.throws(
      () => beeThreads.run(null),
      TypeError
    );
  });

  await test('withTimeout() throws for negative timeout', () => {
    assert.throws(
      () => beeThreads.withTimeout(-100),
      TypeError
    );
  });

  await test('withTimeout() throws for non-number', () => {
    assert.throws(
      () => beeThreads.withTimeout('100'),
      TypeError
    );
  });

  await test('withTimeout() throws for Infinity', () => {
    assert.throws(
      () => beeThreads.withTimeout(Infinity),
      TypeError
    );
  });

  await test('configure() throws for non-integer poolSize', () => {
    assert.throws(
      () => beeThreads.configure({ poolSize: 2.5 }),
      TypeError
    );
  });

  await test('configure() throws for zero poolSize', () => {
    assert.throws(
      () => beeThreads.configure({ poolSize: 0 }),
      TypeError
    );
  });

  await test('stream() throws TypeError for non-function', () => {
    assert.throws(
      () => beeThreads.stream('not a generator'),
      TypeError
    );
  });

  // ---------- POOL MANAGEMENT ----------
  section('Pool Management');

  await test('getPoolStats() returns valid stats', async () => {
    await beeThreads.run((x) => x).usingParams(1).execute();
    const stats = beeThreads.getPoolStats();
    assert.ok(typeof stats.maxSize === 'number');
    assert.ok(typeof stats.normal.size === 'number');
    assert.ok(typeof stats.normal.busy === 'number');
    assert.ok(typeof stats.normal.idle === 'number');
    assert.ok(Array.isArray(stats.normal.workers));
    assert.ok(stats.metrics.totalTasksExecuted >= 1);
  });

  await test('configure() updates poolSize', () => {
    const originalMax = beeThreads.getPoolStats().maxSize;
    beeThreads.configure({ poolSize: 10 });
    assert.strictEqual(beeThreads.getPoolStats().maxSize, 10);
    beeThreads.configure({ poolSize: originalMax });
  });
  
  await test('configure() updates pool options', () => {
    beeThreads.configure({ maxQueueSize: 500, maxTemporaryWorkers: 5 });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.maxQueueSize, 500);
    assert.strictEqual(stats.config.maxTemporaryWorkers, 5);
  });

  await test('getPoolStats() returns frozen object', () => {
    const stats = beeThreads.getPoolStats();
    assert.ok(Object.isFrozen(stats), 'stats should be frozen');
    assert.ok(Object.isFrozen(stats.normal), 'stats.normal should be frozen');
    assert.ok(Object.isFrozen(stats.config), 'stats.config should be frozen');
    
    assert.throws(() => {
      'use strict';
      stats.maxSize = 999;
    }, TypeError);
  });

  await test('transfer() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.transfer === 'function', 'transfer method should exist');
  });

  await test('signal() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.signal === 'function', 'signal method should exist');
  });

  // ---------- CURRIED REUSABILITY ----------
  section('Curried API');

  await test('executor can be reused multiple times', async () => {
    const double = beeThreads.run((x) => x * 2);
    
    const r1 = await double.usingParams(5).execute();
    const r2 = await double.usingParams(10).execute();
    const r3 = await double.usingParams(21).execute();
    
    assert.strictEqual(r1, 10);
    assert.strictEqual(r2, 20);
    assert.strictEqual(r3, 42);
  });

  await test('multiple executors work independently', async () => {
    const add = beeThreads.run((a, b) => a + b);
    const mul = beeThreads.run((a, b) => a * b);
    
    const sum = await add.usingParams(10, 5).execute();
    const product = await mul.usingParams(10, 5).execute();
    
    assert.strictEqual(sum, 15);
    assert.strictEqual(product, 50);
  });

  // ---------- EDGE CASES ----------
  section('Edge Cases');

  await test('handles undefined return', async () => {
    const result = await beeThreads.run(() => undefined).usingParams().execute();
    assert.strictEqual(result, undefined);
  });

  await test('handles null return', async () => {
    const result = await beeThreads.run(() => null).usingParams().execute();
    assert.strictEqual(result, null);
  });

  await test('handles object return', async () => {
    const result = await beeThreads
      .run(() => ({ foo: 'bar', num: 42 }))
      .usingParams()
      .execute();
    assert.deepStrictEqual(result, { foo: 'bar', num: 42 });
  });

  await test('handles array return', async () => {
    const result = await beeThreads
      .run(() => [1, 2, 3, 'four'])
      .usingParams()
      .execute();
    assert.deepStrictEqual(result, [1, 2, 3, 'four']);
  });

  await test('handles nested data structures', async () => {
    const result = await beeThreads
      .run(() => ({
        arr: [1, { nested: true }, [2, 3]],
        obj: { deep: { value: 42 } }
      }))
      .usingParams()
      .execute();
    assert.deepStrictEqual(result, {
      arr: [1, { nested: true }, [2, 3]],
      obj: { deep: { value: 42 } }
    });
  });

  await test('handles no arguments', async () => {
    const result = await beeThreads.run(() => 'no args').usingParams().execute();
    assert.strictEqual(result, 'no args');
  });

  // ---------- ABORT SIGNAL ----------
  section('AbortSignal Support');

  await beeThreads.shutdown();

  await test('aborts task with AbortController', async () => {
    const controller = new AbortController();
    
    const task = beeThreads
      .run(() => {
        const start = Date.now();
        while (Date.now() - start < 5000) {}
        return 'done';
      })
      .usingParams()
      .signal(controller.signal)
      .execute();
    
    setTimeout(() => controller.abort(), 50);
    
    await assert.rejects(task, AbortError);
  });

  await test('respects already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    
    await assert.rejects(
      beeThreads
        .run(() => 'should not run')
        .usingParams()
        .signal(controller.signal)
        .execute(),
      AbortError
    );
  });

  await beeThreads.shutdown();

  await test('safeRun returns rejected result on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    
    const result = await beeThreads
      .safeRun(() => 'should not run')
      .usingParams()
      .signal(controller.signal)
      .execute();
    
    assert.strictEqual(result.status, 'rejected');
    assert.ok(result.error instanceof AbortError);
  });

  await test('fluent API chains correctly', async () => {
    const controller = new AbortController();
    
    const exec = beeThreads
      .run((x) => x * 2)
      .signal(controller.signal)
      .retry({ maxAttempts: 2 })
      .usingParams(21);
    
    const result = await exec.execute();
    assert.strictEqual(result, 42);
  });

  // ---------- TYPED ERRORS ----------
  section('Typed Errors');

  await test('AbortError has correct properties', () => {
    const err = new AbortError('custom message');
    assert.strictEqual(err.name, 'AbortError');
    assert.strictEqual(err.code, 'ERR_ABORTED');
    assert.strictEqual(err.message, 'custom message');
  });

  await test('TimeoutError has correct properties', () => {
    const err = new TimeoutError(5000);
    assert.strictEqual(err.name, 'TimeoutError');
    assert.strictEqual(err.code, 'ERR_TIMEOUT');
    assert.strictEqual(err.timeout, 5000);
  });

  await test('WorkerError wraps errors from worker', async () => {
    try {
      await beeThreads
        .run(() => { throw new RangeError('out of range'); })
        .usingParams()
        .execute();
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof WorkerError);
      assert.strictEqual(err.name, 'RangeError');
    }
  });

  // ---------- RETRY ----------
  section('Retry Support');

  await test('retry() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.retry === 'function', 'retry method should exist');
  });

  let retryAttempt = 0;
  await test('retry succeeds on transient failure simulation', async () => {
    retryAttempt = 0;
    const result = await beeThreads
      .run((attempt) => {
        if (attempt < 2) {
          throw new Error('transient');
        }
        return 'success';
      })
      .usingParams(2)
      .retry({ maxAttempts: 3, baseDelay: 10 })
      .execute();
    
    assert.strictEqual(result, 'success');
  });

  // ---------- RESOURCE LIMITS ----------
  section('Resource Limits');

  await test('configure() accepts resourceLimits', () => {
    beeThreads.configure({
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 64
      }
    });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.resourceLimits.maxOldGenerationSizeMb, 256);
  });

  // ---------- CONTEXT (CLOSURES) ----------
  section('setContext() - Closure Injection');

  await beeThreads.shutdown();

  await test('setContext() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.setContext === 'function', 'setContext method should exist');
  });

  await test('setContext() injects variables into function scope', async () => {
    const factor = 10;
    const prefix = 'result:';
    
    const result = await beeThreads
      .run((x) => prefix + (x * factor))
      .usingParams(5)
      .setContext({ factor, prefix })
      .execute();
    
    assert.strictEqual(result, 'result:50');
  });

  await test('setContext() works with multiple variables', async () => {
    const config = { multiplier: 3, offset: 100 };
    const label = 'value';
    
    const result = await beeThreads
      .run((x) => ({ [label]: x * config.multiplier + config.offset }))
      .usingParams(10)
      .setContext({ config, label })
      .execute();
    
    assert.deepStrictEqual(result, { value: 130 });
  });

  await test('setContext() works with stream/generators', async () => {
    const multiplier = 2;
    
    const stream = beeThreads
      .stream(function* (n) {
        for (let i = 1; i <= n; i++) {
          yield i * multiplier;
        }
      })
      .usingParams(3)
      .setContext({ multiplier })
      .execute();
    
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    assert.deepStrictEqual(chunks, [2, 4, 6]);
  });

  await beeThreads.shutdown();

  // ---------- USING PARAMS ----------
  section('usingParams() - Arguments');

  await test('usingParams() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.usingParams === 'function', 'usingParams method should exist');
  });

  await test('usingParams() passes arguments correctly', async () => {
    const result = await beeThreads
      .run((a, b, c) => a + b + c)
      .usingParams(10, 20, 12)
      .execute();
    
    assert.strictEqual(result, 42);
  });

  await test('usingParams() can be chained', async () => {
    const result = await beeThreads
      .run((a, b, c, d) => a + b + c + d)
      .usingParams(1)
      .usingParams(2)
      .usingParams(3, 4)
      .execute();
    
    assert.strictEqual(result, 10);
  });

  await test('usingParams() combines with setContext()', async () => {
    const factor = 2;
    
    const result = await beeThreads
      .run((a, b) => (a + b) * factor)
      .usingParams(10, 20)
      .setContext({ factor })
      .execute();
    
    assert.strictEqual(result, 60);
  });

  await test('execute() works with empty usingParams', async () => {
    const result = await beeThreads
      .run(() => 42)
      .usingParams()
      .execute();
    
    assert.strictEqual(result, 42);
  });

  await beeThreads.shutdown();

  // ---------- LOAD BALANCING ----------
  section('Load Balancing');

  await beeThreads.shutdown();

  await test('distributes tasks across workers (least-used)', async () => {
    beeThreads.configure({ poolSize: 3 });
    
    for (let i = 0; i < 6; i++) {
      await beeThreads.run(() => 'task').usingParams().execute();
    }
    
    const stats = beeThreads.getPoolStats();
    const execCounts = stats.normal.workers.map(w => w.tasksExecuted);
    assert.ok(execCounts.length <= 3, 'Should use max 3 workers');
    const max = Math.max(...execCounts);
    const min = Math.min(...execCounts);
    assert.ok(max - min <= 1, `Tasks not evenly distributed: ${execCounts.join(', ')}`);
  });

  await beeThreads.shutdown();

  await test('queues tasks when pool is full', async () => {
    beeThreads.configure({ poolSize: 1, maxTemporaryWorkers: 0 });
    
    const task1 = beeThreads
      .run(() => {
        const start = Date.now();
        while (Date.now() - start < 50) {}
        return 1;
      })
      .usingParams()
      .execute();
    
    const task2 = beeThreads.run(() => 2).usingParams().execute();
    
    const results = await Promise.all([task1, task2]);
    assert.deepStrictEqual(results, [1, 2]);
  });

  await beeThreads.shutdown();
  beeThreads.configure({ poolSize: 4, maxTemporaryWorkers: 10 });

  await test('tracks execution metrics', async () => {
    const statsBefore = beeThreads.getPoolStats();
    const before = statsBefore.metrics.totalTasksExecuted;
    
    await beeThreads.run(() => 1).usingParams().execute();
    await beeThreads.run(() => 2).usingParams().execute();
    
    const statsAfter = beeThreads.getPoolStats();
    assert.ok(statsAfter.metrics.totalTasksExecuted >= before + 2);
  });

  await test('tracks failure counts per worker', async () => {
    try {
      await beeThreads.run(() => { throw new Error('fail'); }).usingParams().execute();
    } catch {}
    
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.metrics.totalTasksFailed >= 1);
  });

  // ---------- CLEANUP ----------
  section('Cleanup');

  await test('shutdown() terminates all workers', async () => {
    await beeThreads.run(() => 1).usingParams().execute();
    
    const statsBefore = beeThreads.getPoolStats();
    assert.ok(statsBefore.normal.size > 0, 'Should have workers');
    
    await beeThreads.shutdown();
    
    const statsAfter = beeThreads.getPoolStats();
    assert.strictEqual(statsAfter.normal.size, 0);
  });

  // ---------- SUMMARY ----------
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
