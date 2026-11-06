/**
 * Content-Security-Policy del renderer (RNF-SEG-01, ESP §4 "sin contenido remoto en ventanas privilegiadas").
 * El renderer no hace red: toda comunicación pasa por IPC tipado hacia main. Sin `unsafe-inline`/`unsafe-eval`
 * en build. La variante de desarrollo solo existe para el servidor Vite en loopback (HMR).
 */
export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
