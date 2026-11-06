/* global process, console, setInterval */
// Ejecutor simulado para la prueba de cancelación (launcher `process`): crea un nieto en su PROPIO grupo de
// procesos (como Chromium lanzado por Playwright) y, según FAKE_MODE, ignora SIGTERM (fuerza SIGKILL) o coopera.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.KATALYST_OUTPUT_DIR;
const secrets = process.env.KATALYST_SECRETS_DIR;
const mode = process.env.FAKE_MODE ?? 'stubborn';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(out, 'pids.json'), JSON.stringify({ self: process.pid, grandchild: child.pid, worker: worker.pid }));
process.on('SIGTERM', () => {
  let stop = 'none';
  try {
    stop = JSON.parse(fs.readFileSync(path.join(secrets, 'control.json'), 'utf8')).stop;
  } catch {
    // sin control
  }
  fs.writeFileSync(path.join(out, 'sigterm.json'), JSON.stringify({ stop, env: Object.keys(process.env).sort() }));
  if (mode === 'cooperative') {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // ya terminó
    }
    try {
      process.kill(worker.pid, 'SIGKILL');
    } catch {
      // ya terminó
    }
    process.exit(0);
  }
  // stubborn: ignora la señal
});
console.log(JSON.stringify({ msg: 'ejecutor simulado listo', mode }));
setInterval(() => {}, 1000);
