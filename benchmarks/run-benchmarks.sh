#!/bin/bash
set -e

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║           BEE-THREADS BENCHMARK SUITE                            ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

echo "System Info:"
echo "  - CPUs: $(nproc)"
echo "  - Memory: $(free -h | grep Mem | awk '{print $2}')"
echo "  - Node: $(node --version)"
echo "  - Bun: $(bun --version)"
echo ""

echo "═══════════════════════════════════════════════════════════════════"
echo "  Running with BUN..."
echo "═══════════════════════════════════════════════════════════════════"
bun benchmarks/full-benchmark.ts

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Running with NODE..."
echo "═══════════════════════════════════════════════════════════════════"
npx tsx benchmarks/full-benchmark.ts

echo ""
echo "✅ All benchmarks complete!"
