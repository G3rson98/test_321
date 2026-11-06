/**
 * @katalyst/shared — contratos (Zod) y lógica pura de dominio, sin IO.
 * Subrutas disponibles: /enums, /errors, /schemas, /schedule, /aggregation, /perf, /sanitize, /rbac, /manifest, /csv.
 */
export const CONTRACT_VERSION = '1.0.0';

export * from './enums.js';
export * from './errors.js';
export * from './schemas/index.js';
export * from './schedule/index.js';
export * from './aggregation/index.js';
export * from './perf/index.js';
export * from './sanitize/index.js';
export * from './rbac/index.js';
export * from './manifest/index.js';
export * from './csv/index.js';
export { sha256Hex, sha256Bytes, canonicalJson } from './crypto/sha256.js';
