/** Versión del paquete @katalyst/runner (se registra en `runtime_versions.runner`, ESP §7/§13.1). */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const RUNNER_VERSION: string = (require('../package.json') as { version: string }).version;
