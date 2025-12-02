# bee-threads - Internal Documentation

> Para contribuidores e desenvolvedores que querem entender/modificar o código.

---

## What Each File Does

### `src/index.js` - Public API

**O que faz:** Ponto de entrada da lib. Exporta `beeThreads` e as classes de erro.

**Por que existe:** Único arquivo que usuários devem importar. Esconde toda a complexidade interna.

```js
// Usuário só precisa saber disso:
const { beeThreads, TimeoutError } = require('bee-threads');
```

**Responsabilidades:**
- Expor `beeThreads.run()`, `safeRun()`, `withTimeout()`, `stream()`
- Expor `configure()`, `shutdown()`, `getPoolStats()`
- Re-exportar classes de erro

---

### `src/config.js` - State Management

**O que faz:** Centraliza TODA configuração e estado mutável.

**Por que existe:** Ter um único lugar pra ver/resetar estado facilita debug e testes.

**Estado que mantém:**
```js
config        // Configurações do usuário (poolSize, timeout, etc)
pools         // Workers ativos { normal: [], generator: [] }
poolCounters  // Contadores O(1) { busy: n, idle: n }
queues        // Tasks esperando worker
metrics       // Estatísticas de execução
```

**Por que poolCounters existe:**
Evita iterar o array de workers só pra contar quantos estão ocupados. `getWorker()` checa `counters.idle > 0` em O(1).

---

### `src/pool.js` - Worker Pool

**O que faz:** Gerencia ciclo de vida dos workers.

**Por que existe:** Separar lógica de pool da lógica de execução.

**Funções principais:**

| Função | O que faz |
|--------|-----------|
| `createWorkerEntry()` | Cria worker com metadata (tasksExecuted, failureCount, etc) |
| `getWorker()` | Pega worker disponível usando least-used balancing |
| `releaseWorker()` | Devolve worker pro pool ou termina se temporário |
| `requestWorker()` | Wrapper async - retorna worker ou enfileira task |
| `scheduleIdleTimeout()` | Agenda terminar worker ocioso após X ms |

**Estratégia de seleção (getWorker):**
```
1. Tem worker idle? → Pega o com menos tasks executadas (load balancing)
2. Pool não cheio? → Cria novo worker
3. Pode criar temporário? → Cria (será terminado após uso)
4. Senão → Enfileira task
```

**Por que least-used:**
Distribui carga uniformemente. Evita cenário onde 1 worker faz tudo enquanto outros ficam parados.

---

### `src/execution.js` - Task Engine

**O que faz:** Executa tasks nos workers.

**Por que existe:** Separar comunicação com worker da lógica de pool/API.

**Funções:**

| Função | O que faz |
|--------|-----------|
| `executeOnce()` | Executa 1 vez (sem retry) |
| `execute()` | Executa com retry se configurado |

**Fluxo de executeOnce:**
```
1. Checa se AbortSignal já foi abortado
2. Pede worker via requestWorker()
3. Configura listeners (message, error, exit)
4. Configura timeout se houver
5. Configura abort handler se houver
6. Envia task: worker.postMessage({ fn, args, context })
7. Espera resposta
8. Cleanup (remove listeners, release worker)
9. Resolve/reject promise
```

**Por que retry é separado:**
`execute()` é um wrapper que chama `executeOnce()` em loop com backoff.

---

### `src/executor.js` - Fluent API Builder

**O que faz:** Constrói a API chainable que o usuário usa.

**Por que existe:** Separar interface do usuário da implementação.

**Pattern usado:** Builder imutável

```js
// Cada método retorna NOVO executor (não muta)
const exec1 = beeThreads.run(fn);
const exec2 = exec1.usingParams(1);  // exec1 não mudou
const exec3 = exec2.setContext({});  // exec2 não mudou
```

**Por que imutável:**
Permite reusar executors parcialmente configurados:
```js
const base = beeThreads.run(fn).setContext({ API_KEY });
await base.usingParams(1).execute();
await base.usingParams(2).execute(); // Reutiliza config
```

---

### `src/stream-executor.js` - Generator Streaming

**O que faz:** Mesmo que executor.js, mas pra generators.

**Por que separado:** Generators têm protocolo diferente (yield/end ao invés de ok/error).

**Output:** `ReadableStream` padrão do Node/Browser.

---

### `src/errors.js` - Error Classes

**O que faz:** Define classes de erro tipadas.

**Por que existe:** Permite `instanceof` checks e códigos de erro consistentes.

```js
class TimeoutError extends AsyncThreadError {
  constructor(ms) {
    super(`Worker timed out after ${ms}ms`, 'ERR_TIMEOUT');
    this.timeout = ms;  // Info extra útil
  }
}
```

**Erros definidos:**

| Classe | Código | Quando |
|--------|--------|--------|
| `AbortError` | `ERR_ABORTED` | Task cancelada via AbortSignal |
| `TimeoutError` | `ERR_TIMEOUT` | Excedeu tempo limite |
| `QueueFullError` | `ERR_QUEUE_FULL` | Fila de tasks cheia |
| `WorkerError` | `ERR_WORKER` | Erro dentro do worker |

---

### `src/worker.js` - Worker Script

**O que faz:** Código que roda no worker thread.

**Por que separado:** Worker é processo isolado, precisa de arquivo próprio.

**Fluxo:**
```
1. Recebe: { fn: string, args: [], context: {} }
2. Valida que fn parece uma função (segurança)
3. Se tem context → injeta variáveis no escopo
4. eval() o código da função
5. Aplica args (suporta curried automaticamente)
6. Se retorno é Promise → espera
7. Envia: { ok: true, value } ou { ok: false, error }
```

**applyCurried() - Por que existe:**
```js
// Função normal: fn(1, 2, 3)
// Curried: fn(1)(2)(3)
// Queremos que ambos funcionem com usingParams(1, 2, 3)
```

---

### `src/generator-worker.js` - Generator Worker

**O que faz:** Worker especializado pra generators.

**Por que separado:** Protocolo diferente - envia múltiplas mensagens (uma por yield).

**Mensagens enviadas:**
```js
{ type: 'yield', value }  // Cada yield
{ type: 'return', value } // Valor final do return
{ type: 'end' }           // Generator terminou
{ type: 'error', error }  // Deu erro
```

---

### `src/validation.js` - Input Validation

**O que faz:** Funções de validação de input.

**Por que separado:** DRY - mesmas validações usadas em vários lugares.

```js
validateFunction(fn)   // Checa se é função
validateTimeout(ms)    // Checa se é número positivo finito
validatePoolSize(n)    // Checa se é inteiro >= 1
validateClosure(obj)   // Checa se é objeto não-null
```

---

### `src/utils.js` - Utilities

**O que faz:** Funções utilitárias genéricas.

**Por que separado:** Reutilizáveis e testáveis isoladamente.

```js
deepFreeze(obj)      // Congela objeto recursivamente (pra getPoolStats)
sleep(ms)            // Promise que resolve após X ms
calculateBackoff()   // Calcula delay exponencial com jitter
```

**Por que jitter no backoff:**
Evita thundering herd - se 100 tasks falharem juntas, não queremos todas retentando no mesmo momento.

---

### `src/index.d.ts` - TypeScript Types

**O que faz:** Definições de tipos pra TypeScript.

**Por que existe:** Autocomplete e type checking pra usuários de TS.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                         User Code                           │
│  beeThreads.run(fn).usingParams(1).setContext({}).execute() │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     executor.js                             │
│  Builds execution config: { fn, args, context, signal }     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    execution.js                             │
│  1. Request worker from pool                                │
│  2. Setup timeout/abort handlers                            │
│  3. Send task to worker                                     │
│  4. Wait for response                                       │
│  5. Cleanup and return result                               │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│       pool.js           │   │       worker.js         │
│  - Get/create worker    │   │  - Receive task         │
│  - Track metrics        │   │  - Inject context       │
│  - Queue if busy        │   │  - Execute function     │
│  - Release after use    │   │  - Send result          │
└─────────────────────────┘   └─────────────────────────┘
```

---

## Adding a New Feature

### Example: Adding `.timeout()` method to executor

1. **Update executor.js:**
```js
executor.timeout = function(ms) {
  return createExecutor({
    fnString,
    options: { ...options, timeout: ms },
    args
  });
};
```

2. **Update index.d.ts** (types)

3. **Add test in test.js**

4. **Update README if user-facing**

---

## Running Tests

```bash
npm test
# or
node test.js
```

---

## Code Style

- JSDoc em todas as funções públicas
- Comentários "Why this exists" em módulos
- Nomes descritivos (não abreviar)
- Funções pequenas e focadas
- Estado centralizado em config.js

---

## License

MIT
