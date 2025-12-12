/**
 * Full Benchmark Suite for bee-threads
 * 
 * Runs each scenario 10 times and calculates mean ± std deviation
 * 
 * Usage:
 *   bun benchmarks/full-benchmark.ts
 *   npx tsx benchmarks/full-benchmark.ts
 */

// ============================================================================
// CONFIG
// ============================================================================

const RUNS = 10;
const WARMUP_RUNS = 2;
const WORKERS_8 = 8;
const WORKERS_12 = 12;

// ============================================================================
// STATS HELPERS
// ============================================================================

interface BenchResult {
  mean: number;
  std: number;
  min: number;
  max: number;
}

function calculateStats(times: number[]): BenchResult {
  const n = times.length;
  const mean = times.reduce((a, b) => a + b, 0) / n;
  const variance = times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return {
    mean: Math.round(mean),
    std: Math.round(std),
    min: Math.round(Math.min(...times)),
    max: Math.round(Math.max(...times)),
  };
}

function formatResult(r: BenchResult): string {
  return `${r.mean} ± ${r.std}ms`;
}

function formatSpeedup(raw: number, turbo: number): string {
  const ratio = raw / turbo;
  if (ratio >= 1.2) return `✅ **${ratio.toFixed(1)}x**`;
  if (ratio >= 1.0) return `✅ ${ratio.toFixed(1)}x`;
  return `❌ ${ratio.toFixed(1)}x`;
}

// ============================================================================
// DATA GENERATORS
// ============================================================================

function generateNumbers(size: number): number[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) arr[i] = Math.random() * 1000;
  return arr;
}

function generateFloat64Array(size: number): Float64Array {
  const arr = new Float64Array(size);
  for (let i = 0; i < size; i++) arr[i] = Math.random() * 1000;
  return arr;
}

function generateStrings(size: number): string[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = `user_${i}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return arr;
}

interface SimpleObject {
  id: number;
  value: number;
  score: number;
}

function generateObjects(size: number): SimpleObject[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = { id: i, value: Math.random() * 1000, score: Math.random() };
  }
  return arr;
}

interface NestedObject {
  id: number;
  user: { name: string; age: number };
  meta: { active: boolean; score: number };
}

function generateNestedObjects(size: number): NestedObject[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = {
      id: i,
      user: { name: `User_${i}`, age: 20 + (i % 50) },
      meta: { active: i % 2 === 0, score: Math.random() * 100 },
    };
  }
  return arr;
}

interface RealWorldUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  age: number;
  balance: number;
  isActive: boolean;
  isPremium: boolean;
}

function generateRealWorldUsers(size: number): RealWorldUser[] {
  const firstNames = ['John', 'Jane', 'Bob', 'Alice', 'Carlos', 'Maria'];
  const lastNames = ['Smith', 'Doe', 'Johnson', 'Williams', 'Brown', 'Garcia'];
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = {
      id: i,
      email: `user${i}@example.com`,
      firstName: firstNames[i % firstNames.length],
      lastName: lastNames[i % lastNames.length],
      age: 18 + (i % 60),
      balance: Math.random() * 10000,
      isActive: i % 5 !== 0,
      isPremium: i % 10 === 0,
    };
  }
  return arr;
}

// ============================================================================
// BENCHMARK FUNCTIONS
// ============================================================================

// CPU-heavy function for numbers
const heavyMathFn = (x: number) => Math.sqrt(x) * Math.sin(x) * Math.cos(x);

// String transformation
const stringFn = (x: string) => x.toUpperCase() + x.length;

// Object transformation
const objectFn = (x: SimpleObject) => ({ ...x, computed: x.value * x.score });

// Nested object transformation
const nestedFn = (x: NestedObject) => ({
  ...x,
  computed: x.user.age * x.meta.score,
  summary: `${x.user.name}: ${x.meta.active ? 'active' : 'inactive'}`,
});

// Real-world transformation
const realWorldFn = (x: RealWorldUser) => ({
  ...x,
  fullName: `${x.firstName} ${x.lastName}`,
  tier: x.isPremium ? 'premium' : x.isActive ? 'active' : 'inactive',
  score: x.balance * (x.isPremium ? 1.5 : 1.0) * (x.isActive ? 1.2 : 0.8),
});

// ============================================================================
// BENCHMARK RUNNER
// ============================================================================

async function benchmarkRaw<T, R>(
  data: T[],
  fn: (x: T) => R,
  runs: number = RUNS
): Promise<BenchResult> {
  // Warmup
  for (let i = 0; i < WARMUP_RUNS; i++) {
    data.map(fn);
  }
  
  // Actual runs
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    data.map(fn);
    times.push(performance.now() - start);
  }
  
  return calculateStats(times);
}

async function benchmarkTurbo<T, R>(
  data: T[],
  fn: (x: T) => R,
  workers: number,
  runs: number = RUNS
): Promise<BenchResult> {
  // Dynamic import - use compiled dist in production, src for local dev
  const { beeThreads } = typeof (globalThis as any).Bun !== 'undefined' 
    ? await import('../dist/index.js')
    : await import('../dist/index.js');
  
  // Warmup
  for (let i = 0; i < WARMUP_RUNS; i++) {
    await beeThreads.turbo(data).setWorkers(workers).map(fn as any);
  }
  
  // Actual runs
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await beeThreads.turbo(data).setWorkers(workers).map(fn as any);
    times.push(performance.now() - start);
  }
  
  return calculateStats(times);
}

// ============================================================================
// MAIN
// ============================================================================

interface ScenarioResult {
  size: string;
  raw: BenchResult;
  turbo8: BenchResult;
  turbo12: BenchResult;
}

async function runScenario<T, R>(
  name: string,
  sizes: number[],
  generator: (size: number) => T[],
  fn: (x: T) => R
): Promise<ScenarioResult[]> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(60));
  
  const results: ScenarioResult[] = [];
  
  for (const size of sizes) {
    const sizeLabel = size >= 1_000_000 
      ? `${size / 1_000_000}M` 
      : size >= 1_000 
        ? `${size / 1_000}K` 
        : `${size}`;
    
    console.log(`\n  Size: ${sizeLabel}`);
    
    const data = generator(size);
    
    process.stdout.write('    raw:      ');
    const raw = await benchmarkRaw(data, fn);
    console.log(formatResult(raw));
    
    process.stdout.write('    turbo(8): ');
    const turbo8 = await benchmarkTurbo(data, fn, WORKERS_8);
    console.log(formatResult(turbo8));
    
    process.stdout.write('    turbo(12):');
    const turbo12 = await benchmarkTurbo(data, fn, WORKERS_12);
    console.log(formatResult(turbo12));
    
    results.push({ size: sizeLabel, raw, turbo8, turbo12 });
  }
  
  return results;
}

function printMarkdownTable(name: string, results: ScenarioResult[], runtime: string) {
  console.log(`\n### ${name}\n`);
  console.log('| Size | Runtime | raw | turbo(8) | turbo(12) | Speedup |');
  console.log('|------|---------|-----|----------|-----------|---------|');
  
  for (const r of results) {
    const speedup = formatSpeedup(r.raw.mean, r.turbo12.mean);
    console.log(
      `| ${r.size} | ${runtime} | ${r.raw.mean}ms | ${r.turbo8.mean}ms | **${r.turbo12.mean}ms** | ${speedup} |`
    );
  }
}

async function main() {
  const runtime = typeof (globalThis as any).Bun !== 'undefined' ? 'Bun' : 'Node';
  
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           BEE-THREADS FULL BENCHMARK SUITE                       ║');
  console.log(`║           Runtime: ${runtime.padEnd(45)}║`);
  console.log(`║           Runs per scenario: ${RUNS}                                   ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  
  // 1. Number Array (Float64Array)
  const numberResults = await runScenario(
    'Number Array (Float64Array)',
    [100_000, 1_000_000, 10_000_000],
    generateNumbers,
    heavyMathFn
  );
  
  // 2. String Array
  const stringResults = await runScenario(
    'String Array',
    [100_000, 1_000_000],
    generateStrings,
    stringFn
  );
  
  // 3. Object Array
  const objectResults = await runScenario(
    'Object Array (AutoPack)',
    [10_000, 100_000, 1_000_000],
    generateObjects,
    objectFn
  );
  
  // 4. Nested Object Array
  const nestedResults = await runScenario(
    'Nested Object Array (AutoPack)',
    [10_000, 100_000, 1_000_000],
    generateNestedObjects,
    nestedFn
  );
  
  // 5. Real-World Users
  const realWorldResults = await runScenario(
    'Real-World User Processing',
    [10_000, 100_000, 1_000_000],
    generateRealWorldUsers,
    realWorldFn
  );
  
  // Print Markdown tables for README
  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           MARKDOWN TABLES FOR README                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  
  printMarkdownTable('Number Array (Float64Array)', numberResults, runtime);
  printMarkdownTable('String Array', stringResults, runtime);
  printMarkdownTable('Object Array (AutoPack enabled)', objectResults, runtime);
  printMarkdownTable('Nested Object Array (AutoPack enabled)', nestedResults, runtime);
  printMarkdownTable('Real-World: User Processing', realWorldResults, runtime);
  
  // Shutdown
  const { beeThreads: bee } = await import('../dist/index.js');
  await bee.shutdown();
  
  console.log('\n✅ Benchmark complete!');
}

main().catch(console.error);

