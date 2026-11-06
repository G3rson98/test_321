// ESLint del asistente: configuración raíz + build de electron-vite ignorado y scripts CommonJS de Node.
import root from '../../eslint.config.js';

const nodeGlobals = Object.fromEntries(
  [
    'require',
    'module',
    '__dirname',
    '__filename',
    'process',
    'console',
    'Buffer',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'URL',
  ].map((g) => [g, 'readonly']),
);

export default [
  { ignores: ['out/**', 'release/**', 'build/ms-playwright/**'] },
  ...root,
  {
    files: ['**/*.cjs', 'scripts/**/*.mjs'],
    languageOptions: { sourceType: 'commonjs', globals: nodeGlobals },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-console': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
];
