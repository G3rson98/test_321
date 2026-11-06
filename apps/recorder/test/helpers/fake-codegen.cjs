// Doble del CLI `playwright codegen` para pruebas: escribe la salida por etapas en --output (como hace codegen,
// que reescribe el archivo mientras se graba) y termina limpio ante SIGTERM. Registra argv/env en --output + '.meta'.
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output') + 1];
fs.writeFileSync(out + '.meta', JSON.stringify({ args, env: process.env }));
const head = "import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n";
const steps = [
  "  await page.goto('https://staging.example.test/schedulings');\n",
  "  await page.getByRole('tab', { name: 'Lista' }).click();\n",
  "  await expect(page.getByRole('grid')).toBeVisible();\n",
];
let i = 0;
const write = () => {
  i = Math.min(i + 1, steps.length);
  fs.writeFileSync(out, head + steps.slice(0, i).join('') + '});\n');
};
write();
const t = setInterval(write, 40);
process.on('SIGTERM', () => {
  clearInterval(t);
  process.exit(0);
});
if (args.includes('--exit-fast')) {
  clearInterval(t);
  process.exit(3);
}
setTimeout(() => process.exit(0), 20000);
