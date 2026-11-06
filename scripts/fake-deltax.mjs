#!/usr/bin/env node
/**
 * Fixture HTML LOCAL que imita lo mínimo de FMS DeltaX para que qa-tests corra de punta a punta sin tocar
 * producción (cbc.deltax.la / fmsapi.deltax.la): formulario de login (etiquetas «Usuario»/«Contraseña», botón
 * «Iniciar sesión»), `GET /users/api/users/current` con la identidad de la sesión y una página principal.
 *
 * Rutas:
 *   GET  /                      login o «Centro de control local» según la cookie de sesión
 *   POST /login                 valida usuario/contraseña (FAKE_DELTAX_USER / KATALYST_SECRET__QA_LOCAL) y fija cookie
 *   GET  /users/api/users/current  {username, email} de la sesión (401 sin sesión)
 *   GET  /espera                página que nunca muestra el texto esperado (prueba de cancelación)
 *   GET  /canario?token=...     (solo con FAKE_DELTAX_CANARIES) expone canarios en DOM, URL, consola y respuestas
 *   GET  /api/canario           respuesta JSON con canarios (solo con FAKE_DELTAX_CANARIES)
 *
 * Uso: node scripts/fake-deltax.mjs [--port 4020]. Variables: FAKE_DELTAX_PORT, FAKE_DELTAX_USER,
 * KATALYST_SECRET__QA_LOCAL (contraseña esperada; vacía = cualquiera no vacía), FAKE_DELTAX_CANARIES (JSON
 * {token, cookie, personal, secret}) para el ensayo de canarios (docs/aceptacion/seguridad.md).
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const PORT = Number(i >= 0 ? argv[i + 1] : (process.env.FAKE_DELTAX_PORT ?? 4020));
const HOST = process.env.FAKE_DELTAX_HOST ?? '127.0.0.1';
const USER = process.env.FAKE_DELTAX_USER ?? 'qa.local@example.test';
const PASSWORD = process.env.KATALYST_SECRET__QA_LOCAL ?? '';
const CANARIES = process.env.FAKE_DELTAX_CANARIES ? JSON.parse(process.env.FAKE_DELTAX_CANARIES) : null;
const sessions = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;

const LOGIN = page(
  'FMS DeltaX (fixture local)',
  `<main><h1>Iniciar sesión en FMS (fixture local)</h1>
<form id="f"><label>Usuario <input id="u" name="username" autocomplete="username"></label>
<label>Contraseña <input id="p" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Iniciar sesión</button></form><div id="err" role="alert" hidden></div></main>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }) });
  if (!r.ok) { const el = document.getElementById('err'); el.hidden = false; el.textContent = 'Usuario o contraseña incorrectos'; return; }
  location.href = '/';
});
</script>`,
);

// Imita el arranque de la raíz (ESP §2): `current` + servicios de la página principal y redirección a
// /controlCenterShipper con el encabezado «Informe operativo» (lo que espera qa-tests C900004).
const HOME = page(
  'Centro de control local',
  `<header><h1>Centro de control local</h1><span id="who">cargando…</span></header>
<nav aria-label="principal"><a href="/">Inicio</a></nav><main id="m" aria-busy="true"></main>
<script>
const svc = ['/place', '/setting/i18n', '/notification/user', '/dashboard/powerBi/token', '/dashboard/shippingOrderIds'];
fetch('/users/api/users/current').then(r => r.json()).then(async u => {
  document.getElementById('who').textContent = u.username;
  await Promise.all(svc.map(p => fetch(p).then(r => r.text())));
  if (location.pathname === '/') history.replaceState(null, '', '/controlCenterShipper');
  const m = document.getElementById('m'); m.setAttribute('aria-busy', 'false');
  m.innerHTML = '<h2>Informe operativo</h2><p data-testid="estado">Aplicación lista</p>';
});
</script>`,
);
const SERVICE_PATHS = new Set(['/place', '/setting/i18n', '/notification/user', '/dashboard/powerBi/token', '/dashboard/shippingOrderIds']);

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=').map(decodeURIComponent)));
}
function session(req) {
  return sessions.get(cookies(req).fx_session ?? '') ?? null;
}
function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const s = session(req);
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, s ? HOME : LOGIN);
  if (req.method === 'POST' && url.pathname === '/login') {
    const b = await readJson(req);
    const ok = b.username === USER && typeof b.password === 'string' && b.password.length > 0 && (!PASSWORD || b.password === PASSWORD);
    if (!ok) return send(res, 401, JSON.stringify({ error: 'credenciales' }), 'application/json');
    const id = randomBytes(18).toString('hex');
    sessions.set(id, { username: USER });
    const extra = CANARIES ? [`fx_canary=${encodeURIComponent(CANARIES.cookie)}; Path=/; SameSite=Lax`] : [];
    return send(res, 204, '', 'text/plain', { 'set-cookie': [`fx_session=${id}; Path=/; HttpOnly; SameSite=Lax`, ...extra] });
  }
  if (req.method === 'GET' && /^\/users\/api\/users\/current\/?$/.test(url.pathname)) {
    if (!s) return send(res, 401, JSON.stringify({ error: 'no autenticado' }), 'application/json');
    return send(res, 200, JSON.stringify({ username: s.username, email: s.username, roles: ['lectura'] }), 'application/json');
  }
  if (req.method === 'GET' && SERVICE_PATHS.has(url.pathname)) {
    if (!s) return send(res, 401, JSON.stringify({ error: 'no autenticado' }), 'application/json');
    // Sin tokens reales: el de Power BI es un marcador sintético.
    return send(res, 200, JSON.stringify({ ok: true, servicio: url.pathname, items: [] }), 'application/json');
  }
  if (req.method === 'GET' && (url.pathname === '/controlCenterShipper' || url.pathname.startsWith('/controlCenterShipper/'))) {
    return send(res, 200, s ? HOME : LOGIN);
  }
  if (req.method === 'GET' && url.pathname === '/espera') {
    return send(res, 200, page('Espera', '<h1>Espera larga</h1><p>Esta página nunca termina de cargar el indicador.</p>'));
  }
  if (CANARIES && req.method === 'GET' && url.pathname === '/api/canario') {
    return send(
      res,
      200,
      JSON.stringify({ accessToken: CANARIES.token, cliente: { nombre: 'Cliente Canario', documento: CANARIES.personal }, clave: CANARIES.secret }),
      'application/json',
      { 'x-katalyst-canary': CANARIES.secret },
    );
  }
  if (CANARIES && req.method === 'GET' && url.pathname === '/canario') {
    const t = url.searchParams.get('token') ?? '';
    return send(
      res,
      200,
      page(
        'Canario',
        `<h1>Página de canarios</h1>
<p data-testid="token">${esc(t)}</p><p data-testid="personal">${esc(CANARIES.personal)}</p>
<p data-testid="secreto">${esc(CANARIES.secret)}</p><input aria-label="Token visible" value="${esc(CANARIES.token)}">
<script>
console.log('token de acceso', ${JSON.stringify(CANARIES.token)});
console.error('secreto en consola', ${JSON.stringify(CANARIES.secret)}, 'documento', ${JSON.stringify(CANARIES.personal)});
localStorage.setItem('accessToken', ${JSON.stringify(CANARIES.token)});
fetch('/api/canario', { headers: { authorization: 'Bearer ' + ${JSON.stringify(CANARIES.token)} } }).then(r => r.json()).then(j => {
  const p = document.createElement('p'); p.dataset.testid = 'respuesta'; p.textContent = JSON.stringify(j); document.body.appendChild(p);
});
</script>`,
      ),
    );
  }
  send(res, 404, page('No encontrado', '<h1>404</h1>'));
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ level: 'info', service: 'fake-deltax', msg: 'fixture DeltaX local lista', url: `http://${HOST}:${PORT}`, canaries: Boolean(CANARIES) }));
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
