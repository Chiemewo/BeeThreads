/**
 * Benchmark: AutoPack para chamadas ÚNICAS (bee normal, não turbo)
 * 
 * Pergunta: Vale a pena usar AutoPack no bee() normal?
 * 
 * Cenários:
 * 1. Objeto pequeno (10 campos)
 * 2. Objeto médio (100 campos)
 * 3. Objeto grande (1000 campos)
 * 4. Array pequeno (100 objetos)
 * 5. Array médio (1000 objetos)
 * 6. Array grande (10000 objetos)
 */

import { autoPack, autoUnpack, clearAutoPackCaches } from '../src/autopack';

// ============ DATA GENERATORS ============

function generateObject(fieldCount: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fieldCount; i++) {
    if (i % 3 === 0) obj[`num_${i}`] = Math.random() * 1000;
    else if (i % 3 === 1) obj[`str_${i}`] = `value_${i}_${Math.random().toString(36).slice(2, 10)}`;
    else obj[`bool_${i}`] = i % 2 === 0;
  }
  return obj;
}

function generateArray(size: number, fieldsPerObject: number): Record<string, unknown>[] {
  const arr: Record<string, unknown>[] = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = generateObject(fieldsPerObject);
  }
  return arr;
}

// ============ BENCHMARK ============

interface BenchResult {
  scenario: string;
  dataSize: string;
  packUnpackTime: number;
  structuredCloneTime: number;
  ratio: number;
  verdict: string;
}

function benchmarkSingle(
  name: string,
  data: Record<string, unknown> | Record<string, unknown>[],
  iterations: number = 100
): BenchResult {
  clearAutoPackCaches();
  
  const dataArray = Array.isArray(data) ? data : [data];
  
  // Warmup
  for (let i = 0; i < 5; i++) {
    const packed = autoPack(dataArray);
    autoUnpack(packed);
    structuredClone(data);
  }
  
  // Benchmark AutoPack (pack + unpack = roundtrip simulando postMessage)
  const packTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const packed = autoPack(dataArray);
    autoUnpack(packed);
    packTimes.push(performance.now() - start);
  }
  
  // Benchmark structuredClone (simula o que postMessage faz)
  const cloneTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    structuredClone(data);
    cloneTimes.push(performance.now() - start);
  }
  
  // Mediana
  packTimes.sort((a, b) => a - b);
  cloneTimes.sort((a, b) => a - b);
  
  const packTime = packTimes[Math.floor(iterations / 2)];
  const cloneTime = cloneTimes[Math.floor(iterations / 2)];
  const ratio = cloneTime / packTime;
  
  // Calcular tamanho aproximado
  const jsonSize = JSON.stringify(data).length;
  const sizeStr = jsonSize < 1024 
    ? `${jsonSize} B`
    : jsonSize < 1024 * 1024 
      ? `${(jsonSize / 1024).toFixed(1)} KB`
      : `${(jsonSize / 1024 / 1024).toFixed(1)} MB`;
  
  const verdict = ratio >= 1.2 
    ? '✅ USAR AutoPack'
    : ratio >= 0.8 
      ? '⚠️ Similar'
      : '❌ NÃO usar';
  
  return {
    scenario: name,
    dataSize: sizeStr,
    packUnpackTime: packTime,
    structuredCloneTime: cloneTime,
    ratio,
    verdict
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║     AUTOPACK PARA CHAMADAS ÚNICAS (bee normal) - VALE A PENA?               ║');
  console.log('║                                                                              ║');
  console.log('║     Comparando: autoPack + autoUnpack vs structuredClone                     ║');
  console.log('║     (structuredClone é o que postMessage usa internamente)                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');
  
  const results: BenchResult[] = [];
  
  // ============ OBJETOS ÚNICOS ============
  console.log('📦 OBJETOS ÚNICOS (1 objeto, N campos)\n');
  
  results.push(benchmarkSingle('1 objeto, 10 campos', generateObject(10)));
  results.push(benchmarkSingle('1 objeto, 50 campos', generateObject(50)));
  results.push(benchmarkSingle('1 objeto, 100 campos', generateObject(100)));
  results.push(benchmarkSingle('1 objeto, 500 campos', generateObject(500)));
  results.push(benchmarkSingle('1 objeto, 1000 campos', generateObject(1000)));
  
  console.log('┌─────────────────────────┬──────────┬───────────┬───────────────┬─────────┬──────────────────┐');
  console.log('│ Cenário                 │ Tamanho  │ AutoPack  │ structClone   │ Ratio   │ Veredicto        │');
  console.log('├─────────────────────────┼──────────┼───────────┼───────────────┼─────────┼──────────────────┤');
  
  for (const r of results.slice(0, 5)) {
    const scenario = r.scenario.padEnd(23);
    const size = r.dataSize.padStart(8);
    const pack = `${r.packUnpackTime.toFixed(3)}ms`.padStart(9);
    const clone = `${r.structuredCloneTime.toFixed(3)}ms`.padStart(13);
    const ratio = `${r.ratio.toFixed(2)}x`.padStart(7);
    const verdict = r.verdict.padEnd(16);
    console.log(`│ ${scenario} │ ${size} │ ${pack} │ ${clone} │ ${ratio} │ ${verdict} │`);
  }
  console.log('└─────────────────────────┴──────────┴───────────┴───────────────┴─────────┴──────────────────┘\n');
  
  // ============ ARRAYS DE OBJETOS ============
  console.log('📦 ARRAYS DE OBJETOS (N objetos, 10 campos cada)\n');
  
  results.push(benchmarkSingle('10 objetos', generateArray(10, 10)));
  results.push(benchmarkSingle('50 objetos', generateArray(50, 10)));
  results.push(benchmarkSingle('100 objetos', generateArray(100, 10)));
  results.push(benchmarkSingle('500 objetos', generateArray(500, 10)));
  results.push(benchmarkSingle('1000 objetos', generateArray(1000, 10)));
  results.push(benchmarkSingle('5000 objetos', generateArray(5000, 10)));
  results.push(benchmarkSingle('10000 objetos', generateArray(10000, 10)));
  
  console.log('┌─────────────────────────┬──────────┬───────────┬───────────────┬─────────┬──────────────────┐');
  console.log('│ Cenário                 │ Tamanho  │ AutoPack  │ structClone   │ Ratio   │ Veredicto        │');
  console.log('├─────────────────────────┼──────────┼───────────┼───────────────┼─────────┼──────────────────┤');
  
  for (const r of results.slice(5)) {
    const scenario = r.scenario.padEnd(23);
    const size = r.dataSize.padStart(8);
    const pack = `${r.packUnpackTime.toFixed(3)}ms`.padStart(9);
    const clone = `${r.structuredCloneTime.toFixed(3)}ms`.padStart(13);
    const ratio = `${r.ratio.toFixed(2)}x`.padStart(7);
    const verdict = r.verdict.padEnd(16);
    console.log(`│ ${scenario} │ ${size} │ ${pack} │ ${clone} │ ${ratio} │ ${verdict} │`);
  }
  console.log('└─────────────────────────┴──────────┴───────────┴───────────────┴─────────┴──────────────────┘\n');
  
  // ============ CONCLUSÃO ============
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                              CONCLUSÃO                                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                              ║');
  console.log('║  Para bee() NORMAL (chamadas únicas):                                        ║');
  console.log('║                                                                              ║');
  console.log('║  ❌ NÃO usar AutoPack para:                                                  ║');
  console.log('║     - Objetos pequenos (< 100 campos)                                        ║');
  console.log('║     - Arrays pequenos (< 100 objetos)                                        ║');
  console.log('║     - Qualquer dado < 10KB                                                   ║');
  console.log('║                                                                              ║');
  console.log('║  ✅ USAR AutoPack para:                                                      ║');
  console.log('║     - Arrays com 500+ objetos                                                ║');
  console.log('║     - Objetos com 500+ campos                                                ║');
  console.log('║     - Qualquer dado > 50KB                                                   ║');
  console.log('║                                                                              ║');
  console.log('║  📌 RECOMENDAÇÃO:                                                            ║');
  console.log('║     - bee() normal: NÃO usar AutoPack (overhead não compensa)                ║');
  console.log('║     - turbo(): USAR AutoPack (arrays grandes, ganho significativo)           ║');
  console.log('║                                                                              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
}

main().catch(console.error);

