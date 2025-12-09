# 🐝⚡ bee.turbo - Proposta de Design

> **Status:** Proposta / Ideação  
> **Data:** Dezembro 2024  
> **Versão alvo:** 4.0.0

---

## Resumo Executivo

`bee.turbo` é uma nova API que permite processar arrays grandes usando **TODOS os workers disponíveis** em paralelo, com **SharedArrayBuffer** para zero-copy quando possível.

**Diferencial BeeThreads:** Uma linha de código, zero configuração, decisões inteligentes automáticas.

---

## Motivação

### Problema Atual

```javascript
// bee() normal - usa 1 worker por vez
const results = await bee((arr) => arr.map(x => Math.sqrt(x)))(hugeArray);
// ⏱️ 4.2 segundos para 1M items
```

### Solução Proposta

```javascript
// bee.turbo - divide entre TODOS os workers
const results = await bee.turbo((x) => Math.sqrt(x))(hugeArray);
// ⏱️ 580ms para 1M items (7x mais rápido)
```

---

## Análise de Mercado

| Biblioteca | Abordagem | DX | Problema |
|------------|-----------|-----|----------|
| **Parallel.js** | `new Parallel(data).map(fn)` | Média | Requer instanciar objeto, configurar |
| **Hamsters.js** | `hamsters.run({ params, fn })` | Baixa | Config verbosa, muitos parâmetros |
| **Threads.js** | `spawn(worker).method()` | Média | Precisa criar arquivo de worker separado |

**Oportunidade:** Nenhuma oferece a simplicidade de "uma linha" que o `bee()` oferece.

---

## Filosofia de Design

> **"Tomando decisões inteligentes pelo desenvolvedor"**

1. **Zero configuração** - funciona out-of-the-box
2. **Auto-detectar** quando vale a pena usar turbo
3. **Esconder complexidade** de SharedArrayBuffer/Atomics
4. **Fallback inteligente** quando turbo não ajuda

---

## API Proposta

### Uso Básico (90% dos casos)

```javascript
import { bee } from 'bee-threads';

// Uma linha. Pronto.
const results = await bee.turbo((x) => Math.sqrt(x))(hugeArray);
```

### Como Funciona Por Baixo

```
bee.turbo(fn)(array)
       │
       ▼
┌─────────────────────────────────────┐
│ 1. Detecta quantos workers tem      │
│ 2. Divide array em N chunks         │
│ 3. Distribui para todos workers     │
│ 4. Usa SharedArrayBuffer se possível│
│ 5. Junta resultados automaticamente │
└─────────────────────────────────────┘
       │
       ▼
   [resultados]
```

### Auto-Detection Inteligente

```
bee.turbo(fn)(data)
  │
  ├─► Array pequeno (< 10.000 items)?
  │     └─► Usa bee() normal (overhead não vale)
  │
  ├─► TypedArray (Float64Array, etc)?
  │     └─► Usa SharedArrayBuffer (zero-copy) 🚀
  │
  ├─► Array de objetos JS?
  │     └─► Usa transferência estruturada (copia, mas paralelo)
  │
  └─► Função não paralelizável detectada?
        └─► Warning + fallback para bee() normal
```

---

## Exemplos de Uso

### Processamento Numérico (Ideal)

```javascript
// TypedArray = SharedArrayBuffer = MÁXIMA PERFORMANCE
const squares = await bee.turbo((x) => x * x)(new Float64Array(10_000_000));
```

### Array Normal

```javascript
// Também funciona, divide e conquista
const processed = await bee.turbo((item) => heavyTransform(item))(bigArray);
```

### Com Contexto

```javascript
const results = await bee.turbo((x) => x * multiplier)(array, { multiplier: 2 });
```

### Async Também Funciona

```javascript
const fetched = await bee.turbo(async (url) => {
  const res = await fetch(url);
  return res.json();
})(urls);
```

---

## API Avançada (10% dos casos)

Para quem quer controle:

```javascript
// Controle manual de workers
const results = await bee.turbo(fn, { 
  workers: 4,           // Default: todos disponíveis
  chunkSize: 1000,      // Default: auto (array.length / workers)
})(array);

// Reduce paralelo (árvore de redução)
const sum = await bee.turbo.reduce((a, b) => a + b)(numbers);

// Filter paralelo
const filtered = await bee.turbo.filter((x) => x > 100)(numbers);
```

---

## Comparação de Código

### Hamsters.js (12 linhas)

```javascript
hamsters.run({
  array: data,
  threads: hamsters.maxThreads,
  fn: function() {
    for(var i = 0; i < params.array.length; i++) {
      rtn.data.push(Math.sqrt(params.array[i]));
    }
  }
}, function(results) {
  console.log(results);
});
```

### Parallel.js (6 linhas)

```javascript
var p = new Parallel(data, { maxWorkers: 4 });
p.map(function(n) {
  return Math.sqrt(n);
}).then(function(results) {
  console.log(results);
});
```

### bee.turbo (1 linha) ✨

```javascript
const results = await bee.turbo((n) => Math.sqrt(n))(data);
```

---

## Mensagens Inteligentes (DX)

```javascript
// Se o usuário usar turbo onde não faz sentido:
await bee.turbo((x) => x + 1)([1, 2, 3]);
// Console: ⚡ bee.turbo: Array com 3 items - usando bee() normal (turbo não acelera arrays pequenos)

// Se detectar que seria mais lento:
await bee.turbo((x) => x)(tinyArray);
// Console: ⚡ bee.turbo: Overhead estimado (5ms) > processamento (0.1ms). Usando modo normal.

// Se tudo certo:
await bee.turbo((x) => heavyMath(x))(hugeArray);
// Console: ⚡ bee.turbo: 10M items → 8 workers → ~1.25M items/worker
```

---

## Performance Esperada

| Array Size | `bee()` | `bee.turbo()` | Speedup |
|------------|---------|---------------|---------|
| 1K items | 5ms | 15ms | ❌ (overhead) |
| 10K items | 45ms | 20ms | **2.2x** |
| 100K items | 450ms | 120ms | **3.7x** |
| 1M items | 4.2s | 580ms | **7.2x** |
| 10M items | 42s | 5.8s | **7.2x** |

*Baseado em 8-core CPU com operações numéricas*

---

## Quando Usar

| Use Case | `bee()` | `bee.turbo()` |
|----------|---------|---------------|
| Single heavy task | ✅ | ❌ |
| Process 10K+ items | ❌ | ✅ |
| TypedArray math | ❌ | ✅✅✅ |
| Small arrays (<1K) | ✅ | ❌ (overhead) |
| Image processing (pixels) | ❌ | ✅✅✅ |
| Matrix operations | ❌ | ✅✅✅ |

---

## Decisões Técnicas

| Decisão | Escolha | Justificativa |
|---------|---------|---------------|
| **Threshold para turbo** | 10.000 items | Abaixo disso, overhead > ganho |
| **SharedArrayBuffer** | Auto para TypedArray | Zero-copy, máxima performance |
| **Fallback** | Silencioso para bee() | Nunca quebra, sempre funciona |
| **Chunk strategy** | `length / workers` | Simples, balanceado |
| **Result merge** | `concat` | Mantém ordem original |

---

## Limitações Conhecidas

### SharedArrayBuffer só funciona com TypedArrays

```javascript
// ✅ Zero-copy (SharedArrayBuffer)
new Float64Array(1_000_000)
new Int32Array(1_000_000)
new Uint8Array(1_000_000)

// ⚠️ Funciona mas copia dados (estruturada)
[{ name: "João" }, { name: "Maria" }]
["string1", "string2", "string3"]
```

### Nem toda operação é paralelizável

```javascript
// ✅ Paralelizável (cada item independente)
array.map(x => x * 2)

// ❌ Não paralelizável (depende do anterior)  
array.reduce((acc, x) => acc + x)  // Precisa de reduce especial
```

### Overhead para arrays pequenos

```javascript
// ❌ Turbo é mais LENTO para arrays pequenos
bee.turbo(fn)([1, 2, 3, 4, 5])  // Overhead de coordenação > ganho

// BeeThreads detecta isso e usa bee() normal automaticamente
```

---

## Arquitetura Proposta

```
┌─────────────────────────────────────────────────────────────────┐
│                     bee.turbo(fn)(array)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │   ANALYZER        │
                    │ • Array size      │
                    │ • Is TypedArray?  │
                    │ • Worth turbo?    │
                    └─────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
        [worth it]                      [not worth]
              │                               │
              ▼                               ▼
┌─────────────────────────┐        ┌─────────────────┐
│      TURBO MODE         │        │   NORMAL MODE   │
│                         │        │   (fallback)    │
│ ┌─────────────────────┐ │        │                 │
│ │ 1. Create SharedBuf │ │        │  bee(fn)(array) │
│ │ 2. Split into chunks│ │        │                 │
│ │ 3. Dispatch to ALL  │ │        └─────────────────┘
│ │    workers          │ │
│ │ 4. Wait for all     │ │
│ │ 5. Merge results    │ │
│ └─────────────────────┘ │
└─────────────────────────┘
              │
              ▼
        [results array]
```

---

## Próximos Passos

1. [ ] Validar API com usuários (feedback)
2. [ ] Implementar POC com SharedArrayBuffer
3. [ ] Benchmark vs Parallel.js / Hamsters.js
4. [ ] Implementar auto-detection
5. [ ] Escrever testes
6. [ ] Documentação completa
7. [ ] Release como v4.0.0

---

## Notas Adicionais

### Por que 4.0.0?

- Nova API pública (`bee.turbo`)
- Pode ter breaking changes na config
- Feature significativa que merece major version

### Inspirações

- Rust's Rayon (parallel iterators)
- Go's goroutines (lightweight parallelism)
- Python's multiprocessing.Pool.map

---

## Resumo

**bee.turbo é:**
- ✅ Uma linha de código
- ✅ Zero configuração  
- ✅ Decisões automáticas inteligentes
- ✅ Fallback gracioso
- ✅ Mensagens úteis no console

**bee.turbo NÃO é:**
- ❌ Mágica que acelera tudo
- ❌ Substituto para bee() normal
- ❌ Complexo de usar

---

*Documento criado em Dezembro 2024 - BeeThreads Team* 🐝⚡

