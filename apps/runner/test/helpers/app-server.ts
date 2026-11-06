/** Aplicación HTML local servida por la propia prueba (sin internet): login, panel y página lenta. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startAppServer(expected: { username: string; password: string }) {
  const sessions = new Set<string>();
  const server = http.createServer((req, res) => {
    const cookie = /session=([a-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>`);
    };
    if (req.method === 'GET' && req.url === '/login') {
      return html(`<form method="post" action="/login"><label>Usuario <input name="u"></label><label>Clave <input name="p" type="password"></label><button type="submit">Entrar</button></form>`);
    }
    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('u') === expected.username && f.get('p') === expected.password) {
          const sid = Math.random().toString(36).slice(2);
          sessions.add(sid);
          res.writeHead(302, { location: '/app', 'set-cookie': `session=${sid}; HttpOnly; Path=/` });
          res.end();
          return;
        }
        res.writeHead(401).end('no');
      });
      return undefined;
    }
    if (req.url === '/app') {
      if (!cookie || !sessions.has(cookie)) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      return html(`<h1>Panel</h1><p>Hola <span data-testid="identidad">${expected.username}</span></p>`);
    }
    res.writeHead(404).end();
    return undefined;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
