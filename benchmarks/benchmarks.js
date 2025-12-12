/**
 * 🐝 bee-threads Benchmark Suite
 * 
 * Run with:
 *   bun benchmarks.js
 *   node benchmarks.js
 * 
 * Compares: main thread vs turbo
 * Measures: execution time, CPU usage
 */

const os = require('os');
const { bee, beeThreads } = require('./dist/index.js');

const cpus = os.cpus().length;
const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node';

// Config - Adjust based on your system
const SIZE = 1_000_000;
const RUNS = 10; // Number of runs for averaging

// Heavy function (CPU intensive)
const heavyFn = (x) => {
  let v = x;
  for (let i = 0; i < 10; i++) {
    v = Math.sqrt(Math.abs(Math.sin(v) * 1000));
  }
  return v;
};

// CPU usage measurement
function getCpuUsage() {
  const usage = process.cpuUsage();
  return {
    user: usage.user / 1000,
    system: usage.system / 1000
  };
}

async function benchmark(name, fn) {
  const times = [];
  const cpuTimes = [];
  
  // Warmup run
  await fn();
  
  // Measured runs
  for (let run = 0; run < RUNS; run++) {
    const cpuStart = getCpuUsage();
    const start = performance.now();
    
    await fn();
    
    const elapsed = performance.now() - start;
    const cpuEnd = getCpuUsage();
    const cpuUsed = (cpuEnd.user - cpuStart.user) + (cpuEnd.system - cpuStart.system);
    
    times.push(elapsed);
    cpuTimes.push(cpuUsed);
  }
  
  // Calculate stats
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const stdDev = arr => {
    const mean = avg(arr);
    return Math.sqrt(arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / arr.length);
  };
  
  const ms = avg(times);
  const msStd = stdDev(times);
  const cpu = avg(cpuTimes);
  // CPU usage as percentage: (total CPU time / elapsed time) * 100
  // >100% means multiple cores were used
  const cpuUsage = (cpu / ms) * 100;
  
  return { name, ms, msStd, cpu, cpuUsage };
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           🐝 bee-threads Benchmark Suite                      ║
╠═══════════════════════════════════════════════════════════════╣
║  Runtime: ${runtime.padEnd(10)} │ CPUs: ${String(cpus).padEnd(4)} │ Array: ${(SIZE/1e6).toFixed(1)}M items   ║
║  Function: Heavy (Math.sqrt + Math.sin × 10 iterations)       ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const arr = new Array(SIZE).fill(0).map((_, i) => i);
  const results = [];

  // 1) Main thread
  console.log('⏳ Testing main thread...');
  results.push(await benchmark('main', () => {
    arr.map(heavyFn);
  }));

  // 2) bee() - single worker
  console.log('⏳ Testing bee()...');
  try {
    const beeResult = await Promise.race([
      benchmark('bee', async () => {
        await bee((data) => {
          return data.map(x => {
            let v = x;
            for (let i = 0; i < 10; i++) v = Math.sqrt(Math.abs(Math.sin(v) * 1000));
            return v;
          });
        })(arr);
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120000))
    ]);
    results.push(beeResult);
  } catch (e) {
    console.log('   ⚠️ bee() timed out or failed');
    results.push({ name: 'bee', ms: Infinity, msStd: 0, cpu: 0, cpuUsage: 0 });
  }

  // 3) turbo with different worker counts
  const workerConfigs = [4, 8, cpus];
  if (cpus > 8) workerConfigs.push(cpus + 4);
  for (const workers of workerConfigs) {
    console.log(`⏳ Testing turbo(${workers})...`);
    try {
      const result = await Promise.race([
        benchmark(`turbo(${workers})`, async () => {
          await beeThreads.turbo(arr, { workers, force: true }).map(heavyFn);
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))
      ]);
      results.push(result);
    } catch (e) {
      console.log(`   ⚠️ turbo(${workers}) timed out`);
      results.push({ name: `turbo(${workers})`, ms: Infinity, msStd: 0, cpu: 0, cpuUsage: 0 });
    }
  }

  // Print results
  const mainMs = results[0].ms;
  
  console.log(`
┌─────────────┬────────────────┬─────────┬─────────────┐
│    Mode     │  Time (±std)   │ vs Main │ Main Thread │
├─────────────┼────────────────┼─────────┼─────────────┤`);

  for (const r of results) {
    const speedup = (mainMs / r.ms).toFixed(2);
    const marker = parseFloat(speedup) >= 1 ? '✅' : '  ';
    const timeStr = `${r.ms.toFixed(0)}±${r.msStd.toFixed(0)}ms`;
    const blocking = r.name === 'main' ? '❌ blocked' : '✅ free';
    console.log(`│ ${r.name.padEnd(11)} │ ${timeStr.padStart(14)} │ ${speedup.padStart(5)}x ${marker}│ ${blocking.padEnd(11)} │`);
  }

  console.log(`└─────────────┴────────────────┴─────────┴─────────────┘`);
  console.log(`\n   📈 Stats: ${RUNS} runs per config (+ 1 warmup)`);

  // Summary
  const best = results.slice(1).reduce((a, b) => a.ms < b.ms ? a : b);
  const bestSpeedup = (mainMs / best.ms).toFixed(2);

  console.log(`
📊 Summary:
   • Best turbo config: ${best.name} (${bestSpeedup}x vs main)
   • Recommended: turbo(${cpus}) for this system
   
💡 Customize workers:
   beeThreads.turbo(arr).setWorkers(${cpus}).map(fn)
`);

  await beeThreads.shutdown();
}

main().catch(console.error);

