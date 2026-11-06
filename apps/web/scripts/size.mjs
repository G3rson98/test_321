#!/usr/bin/env node
/**
 * Presupuesto RNF-OPT-03: JS inicial ≤ 250 KiB gzip. "Inicial" = scripts que index.html carga
 * (<script type="module"> + <link rel="modulepreload">) y sus imports estáticos transitivos.
 * Los chunks cargados con import() (páginas, gráficos, visor de código, PDF) quedan fuera.
 * Falla con código 1 si se excede. Uso: `pnpm --filter @katalyst/web size` (construye antes).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_KIB = Number(process.env.KATALYST_WEB_BUDGET_KIB ?? 250);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('No existe dist/index.html: ejecuta `vite build` primero.');
  process.exit(2);
}
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entries = new Set();
for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) entries.add(m[1]);
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) entries.add(m[1]);

const toFile = (url) => join(dist, url.replace(/^\//, ''));
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const initial = new Map();
const queue = [...entries].map(toFile);
while (queue.length) {
  const file = queue.shift();
  if (initial.has(file) || !existsSync(file)) continue;
  const src = readFileSync(file);
  initial.set(file, gz(src));
  const text = src.toString('utf8');
  // Imports estáticos: `import ... from "./x.js"` y `import "./x.js"` (minificado sin espacios). import() no cuenta.
  for (const m of text.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w$*{},\s]+from\s*)?["']([^"']+\.js)["']/g)) {
    queue.push(resolve(dirname(file), m[1]));
  }
  for (const m of text.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) queue.push(resolve(dirname(file), m[1]));
}

const assets = join(dist, 'assets');
const all = readdirSync(assets).filter((f) => f.endsWith('.js'));
let lazyTotal = 0;
for (const f of all) {
  const p = join(assets, f);
  if (!initial.has(p)) lazyTotal += gz(readFileSync(p));
}
const kib = (n) => (n / 1024).toFixed(1);
let total = 0;
console.log('JS inicial (gzip):');
for (const [file, size] of [...initial].sort((a, b) => b[1] - a[1])) {
  total += size;
  console.log(`  ${kib(size).padStart(7)} KiB  ${file.slice(dist.length + 1)}`);
}
const cssFiles = readdirSync(assets).filter((f) => f.endsWith('.css'));
const css = cssFiles.reduce((n, f) => n + gz(readFileSync(join(assets, f))), 0);
console.log(`  total  ${kib(total)} KiB / presupuesto ${BUDGET_KIB} KiB`);
console.log(`JS diferido (gzip): ${kib(lazyTotal)} KiB en ${all.length - initial.size} chunks · CSS (gzip): ${kib(css)} KiB`);
if (total > BUDGET_KIB * 1024) {
  console.error(`✗ El JS inicial excede el presupuesto RNF-OPT-03 (${kib(total)} > ${BUDGET_KIB} KiB).`);
  process.exit(1);
}
console.log('✓ Dentro del presupuesto RNF-OPT-03.');
