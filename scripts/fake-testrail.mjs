#!/usr/bin/env node
/**
 * TestRail FALSO para desarrollo/aceptación local (NO usar contra producción). Implementa en memoria el subconjunto
 * de la API v2 que usa `apps/api/src/adapters/testrail/http-client.ts`:
 *   GET  index.php?/api/v2/get_projects | get_suites/:p | get_sections/:p&suite_id= | get_cases/:p&suite_id=
 *        (paginados: offset/limit/size/_links.next) | get_priorities | get_case_types | get_runs/:p | get_run/:r
 *        get_results_for_run/:r | get_tests/:r | get_attachments_for_test/:t | get_plan/:id
 *   POST add_run/:p | add_results_for_cases/:r | add_attachment_to_result/:res (multipart) | close_run/:r
 * Autenticación Basic obligatoria (cualquier usuario + la clave de FAKE_TESTRAIL_API_KEY si se define).
 *
 * Inspección (solo loopback): GET /_fake/state (runs, tests, resultados, adjuntos sin binarios),
 * POST /_fake/reset, POST /_fake/fail {op, status, times} para simular caídas.
 *
 * Uso: node scripts/fake-testrail.mjs [--port 4010] [--extra-cases 600] [--data-dir DIR]
 * Variables: FAKE_TESTRAIL_PORT, FAKE_TESTRAIL_EXTRA_CASES, FAKE_TESTRAIL_DATA_DIR, FAKE_TESTRAIL_API_KEY.
 * Los adjuntos se guardan en <data-dir>/attachments/<id>-<nombre> para poder auditarlos (canarios, ESP §13.7).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const PORT = Number(arg('port', process.env.FAKE_TESTRAIL_PORT ?? 4010));
const HOST = arg('host', process.env.FAKE_TESTRAIL_HOST ?? '127.0.0.1');
const EXTRA = Number(arg('extra-cases', process.env.FAKE_TESTRAIL_EXTRA_CASES ?? 600));
const DATA_DIR = arg('data-dir', process.env.FAKE_TESTRAIL_DATA_DIR ?? '');
const API_KEY = process.env.FAKE_TESTRAIL_API_KEY ?? '';
const MAX_LIMIT = 250;

/** Casos que vinculan los tests de qa-tests (placeholders C900001..C900005) y la fixture local (C900006..C900009). */
const LINKED = [
  [900001, 'Órdenes de carga: abrir y recorrer pestañas'],
  [900002, 'Agendamientos: alternar lista y calendario'],
  [900003, 'Instalaciones: ver grilla de configuración'],
  [900004, 'Arranque: raíz y users/current dentro del timeout'],
  [900005, 'Rendimiento: muestras DXMon de servicios principales'],
  [900006, 'Local: página de humo responde y muestra el título'],
  [900007, 'Local: página de humo muestra un indicador que no existe (falla esperada)'],
  [900008, 'Local: espera larga para probar cancelación'],
  [900009, 'Local: canarios de datos sensibles (ESP §13.7)'],
];

let state;
let nextId;
let faults;
function reset() {
  nextId = 10_000;
  faults = new Map();
  state = { projects: [], suites: [], sections: [], cases: [], runs: [], tests: [], results: [], attachments: [], plans: [] };
  const project = { id: 1, name: 'FMS DeltaX (TestRail falso)', is_completed: false, suite_mode: 3 };
  state.projects.push(project);
  const suite = { id: 1, name: 'Regresión FMS', project_id: 1, is_completed: false };
  const suite2 = { id: 2, name: 'Backlog (sin automatizar)', project_id: 1, is_completed: false };
  state.suites.push(suite, suite2);
  const sec = (id, suiteId, name, parentId = null, depth = 0) => {
    const s = { id, suite_id: suiteId, name, parent_id: parentId, depth, display_order: state.sections.length + 1 };
    state.sections.push(s);
    return s;
  };
  const root = sec(100, 1, 'Humo');
  const local = sec(101, 1, 'Fixture local', 100, 1);
  const extra = sec(102, 1, 'Catálogo amplio');
  const backlog = sec(200, 2, 'Pendientes');
  const now = Math.floor(Date.now() / 1000);
  for (const [id, title] of LINKED) {
    state.cases.push({
      id,
      title,
      section_id: id >= 900006 ? local.id : root.id,
      suite_id: 1,
      priority_id: 2,
      type_id: 2,
      refs: null,
      updated_on: now,
      custom_preconds: 'Usuario de prueba de solo lectura',
      custom_steps_separated: [{ content: 'Abrir la pantalla', expected: 'Se muestra sin errores' }],
    });
  }
  for (let i = 0; i < EXTRA; i++) {
    state.cases.push({
      id: 910_000 + i,
      title: `Caso de catálogo ${String(i + 1).padStart(4, '0')} (sin automatizar)`,
      section_id: i % 3 === 0 ? backlog.id : extra.id,
      suite_id: i % 3 === 0 ? 2 : 1,
      priority_id: (i % 3) + 1,
      type_id: 1,
      refs: null,
      updated_on: now,
    });
  }
}
reset();

const send = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};
const err = (res, status, msg) => send(res, status, { error: msg });

function paged(res, key, items, endpoint, params) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit') ?? MAX_LIMIT)));
  const offset = Math.max(0, Number(params.get('offset') ?? 0));
  const page = items.slice(offset, offset + limit);
  const base = [...params.entries()].filter(([k]) => k !== 'limit' && k !== 'offset').map(([k, v]) => `&${k}=${v}`).join('');
  const next = offset + limit < items.length ? `/api/v2/${endpoint}${base}&limit=${limit}&offset=${offset + limit}` : null;
  const prev = offset > 0 ? `/api/v2/${endpoint}${base}&limit=${limit}&offset=${Math.max(0, offset - limit)}` : null;
  send(res, 200, { offset, limit, size: page.length, _links: { next, prev }, [key]: page });
}

function readBody(req, max = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) {
        reject(new Error('cuerpo demasiado grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const start = buf.indexOf(boundary);
  if (start < 0) return null;
  const headerEnd = buf.indexOf('\r\n\r\n', start);
  const headers = buf.subarray(start + boundary.length, headerEnd).toString('utf8');
  const end = buf.indexOf(boundary, headerEnd);
  const content = buf.subarray(headerEnd + 4, end - 2);
  const filename = /filename="([^"]*)"/i.exec(headers)?.[1] ?? 'adjunto.bin';
  const field = /name="([^"]*)"/i.exec(headers)?.[1] ?? '';
  return { field, filename, content };
}

function takeFault(op) {
  const f = faults.get(op);
  if (!f || f.times <= 0) return null;
  f.times -= 1;
  return f;
}

const routes = {
  get_projects: (_a, p, res) => paged(res, 'projects', state.projects, 'get_projects', p),
  get_suites: ([pid], _p, res) => send(res, 200, state.suites.filter((s) => s.project_id === Number(pid))),
  get_sections: ([pid], p, res) => {
    void pid;
    const suiteId = Number(p.get('suite_id'));
    paged(res, 'sections', state.sections.filter((s) => s.suite_id === suiteId), `get_sections/${pid}`, p);
  },
  get_cases: ([pid], p, res) => {
    const suiteId = Number(p.get('suite_id'));
    paged(res, 'cases', state.cases.filter((c) => c.suite_id === suiteId), `get_cases/${pid}`, p);
  },
  get_priorities: (_a, _p, res) =>
    send(res, 200, [
      { id: 1, name: '1 - Low', short_name: 'Low' },
      { id: 2, name: '2 - Medium', short_name: 'Medium' },
      { id: 3, name: '3 - High', short_name: 'High' },
    ]),
  get_case_types: (_a, _p, res) =>
    send(res, 200, [
      { id: 1, name: 'Functional' },
      { id: 2, name: 'Smoke & Sanity' },
    ]),
  get_runs: ([pid], p, res) => {
    const suiteId = p.get('suite_id') ? Number(p.get('suite_id')) : undefined;
    const after = p.get('created_after') ? Number(p.get('created_after')) : undefined;
    const runs = state.runs.filter(
      (r) => r.project_id === Number(pid) && (suiteId === undefined || r.suite_id === suiteId) && (after === undefined || r.created_on >= after),
    );
    paged(res, 'runs', runs, `get_runs/${pid}`, p);
  },
  get_run: ([rid], _p, res) => {
    const r = state.runs.find((x) => x.id === Number(rid));
    return r ? send(res, 200, r) : err(res, 400, 'Field :run_id is not a valid test run.');
  },
  get_results_for_run: ([rid], p, res) => {
    const tids = new Set(state.tests.filter((t) => t.run_id === Number(rid)).map((t) => t.id));
    paged(res, 'results', state.results.filter((r) => tids.has(r.test_id)), `get_results_for_run/${rid}`, p);
  },
  get_tests: ([rid], p, res) => paged(res, 'tests', state.tests.filter((t) => t.run_id === Number(rid)), `get_tests/${rid}`, p),
  get_attachments_for_test: ([tid], p, res) => {
    const rids = new Set(state.results.filter((r) => r.test_id === Number(tid)).map((r) => r.id));
    paged(
      res,
      'attachments',
      state.attachments.filter((a) => rids.has(a.result_id)).map(({ id, name, filename, result_id, size }) => ({ id, name, filename, result_id, size })),
      `get_attachments_for_test/${tid}`,
      p,
    );
  },
  get_plan: ([id], _p, res) => {
    const plan = state.plans.find((x) => x.id === Number(id));
    return plan ? send(res, 200, plan) : err(res, 400, 'Field :plan_id is not a valid test plan.');
  },
  add_run: ([pid], _p, res, body) => {
    const input = JSON.parse(body.toString('utf8') || '{}');
    const caseIds = input.include_all === false || input.case_ids ? (input.case_ids ?? []) : state.cases.filter((c) => c.suite_id === input.suite_id).map((c) => c.id);
    for (const cid of caseIds) if (!state.cases.some((c) => c.id === cid)) return err(res, 400, 'Field :case_ids contains an invalid case.');
    const run = {
      id: nextId++,
      name: String(input.name ?? 'Run'),
      description: input.description ?? null,
      suite_id: input.suite_id ?? null,
      project_id: Number(pid),
      plan_id: null,
      is_completed: false,
      created_on: Math.floor(Date.now() / 1000),
      completed_on: null,
      url: `http://${HOST}:${PORT}/index.php?/runs/view/${nextId - 1}`,
    };
    state.runs.push(run);
    for (const cid of caseIds) {
      const c = state.cases.find((x) => x.id === cid);
      state.tests.push({ id: nextId++, case_id: cid, run_id: run.id, title: c.title, status_id: 3 });
    }
    send(res, 200, run);
  },
  add_results_for_cases: ([rid], _p, res, body) => {
    const run = state.runs.find((x) => x.id === Number(rid));
    if (!run) return err(res, 400, 'Field :run_id is not a valid test run.');
    if (run.is_completed) return err(res, 400, 'Field :run_id refers to a closed test run.');
    const { results = [] } = JSON.parse(body.toString('utf8') || '{}');
    const out = [];
    for (const r of results) {
      const t = state.tests.find((x) => x.run_id === run.id && x.case_id === r.case_id);
      if (!t) return err(res, 400, `Field :results contains a case (${r.case_id}) that is not part of the run.`);
    }
    for (const r of results) {
      const t = state.tests.find((x) => x.run_id === run.id && x.case_id === r.case_id);
      const row = { id: nextId++, test_id: t.id, status_id: r.status_id, comment: r.comment ?? null, elapsed: r.elapsed ?? null, version: r.version ?? null, created_on: Math.floor(Date.now() / 1000) };
      state.results.push(row);
      t.status_id = r.status_id;
      out.push(row);
    }
    send(res, 200, out);
  },
  add_attachment_to_result: ([resultId], _p, res, body, req) => {
    const result = state.results.find((r) => r.id === Number(resultId));
    if (!result) return err(res, 400, 'Field :result_id is not a valid result.');
    const part = parseMultipart(body, req.headers['content-type']);
    if (!part || part.field !== 'attachment') return err(res, 400, 'Field :attachment is required.');
    const id = nextId++;
    const att = { id, name: part.filename, filename: part.filename, result_id: result.id, size: part.content.length };
    if (DATA_DIR) {
      const dir = path.join(DATA_DIR, 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      att.path = path.join(dir, `${id}-${part.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`);
      fs.writeFileSync(att.path, part.content);
    }
    state.attachments.push(att);
    send(res, 200, { attachment_id: id });
  },
  close_run: ([rid], _p, res) => {
    const run = state.runs.find((x) => x.id === Number(rid));
    if (!run) return err(res, 400, 'Field :run_id is not a valid test run.');
    run.is_completed = true;
    run.completed_on = Math.floor(Date.now() / 1000);
    send(res, 200, run);
  },
};
const POSTS = new Set(['add_run', 'add_results_for_cases', 'add_attachment_to_result', 'close_run']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/_fake/')) {
      const op = url.pathname.slice('/_fake/'.length);
      if (op === 'state' && req.method === 'GET') {
        return send(res, 200, { ...state, cases: undefined, caseCount: state.cases.length, attachments: state.attachments.map(({ path: _p, ...a }) => a) });
      }
      if (op === 'reset' && req.method === 'POST') {
        reset();
        return send(res, 200, { ok: true });
      }
      if (op === 'fail' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        faults.set(b.op, { status: Number(b.status ?? 503), times: Number(b.times ?? 1) });
        return send(res, 200, { ok: true });
      }
      return err(res, 404, 'not found');
    }
    if (url.pathname !== '/index.php') return err(res, 404, 'not found');
    const auth = req.headers.authorization ?? '';
    const m = /^Basic (.+)$/.exec(auth);
    const [user, key] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
    if (!user || !key || (API_KEY && key !== API_KEY)) return err(res, 401, 'Authentication failed: invalid or missing user/password or session cookie.');
    // `index.php?/api/v2/get_cases/1&suite_id=2&limit=250` — la query entera es la "ruta".
    const raw = decodeURIComponent(url.search.slice(1));
    const [route, ...rest] = raw.split('&');
    const params = new URLSearchParams(rest.join('&'));
    const mm = /^\/api\/v2\/([a-z_]+)(?:\/(\d+))?$/.exec(route);
    if (!mm) return err(res, 400, 'Unknown method');
    const [, name, id] = mm;
    const handler = routes[name];
    if (!handler) return err(res, 400, `Unknown method '${name}'`);
    if (POSTS.has(name) !== (req.method === 'POST')) return err(res, 400, `Method ${req.method} not allowed for ${name}`);
    const f = takeFault(name);
    if (f) {
      if (f.status === 429) res.setHeader('retry-after', '1');
      return err(res, f.status, 'falla simulada');
    }
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handler(id ? [id] : [], params, res, body, req);
  } catch (e) {
    err(res, 500, `error interno: ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ level: 'info', service: 'fake-testrail', msg: 'TestRail falso listo', url: `http://${HOST}:${PORT}`, cases: state.cases.length }));
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
