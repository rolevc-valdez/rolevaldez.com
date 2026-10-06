// Pruebas de functions/api/patrocinios.js
// Ejecutar con: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onRequestPost } from '../functions/api/patrocinios.js';

// Imitación mínima de la API de Cloudflare D1 sobre SQLite real.
class FakeD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  prepare(sql) {
    const sqlite = this.sqlite;
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async run() {
        const r = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  filas() { return this.sqlite.prepare('SELECT * FROM solicitudes_patrocinio ORDER BY creado_en').all(); }
}

const ORIGEN = 'https://rolevaldez.com';

function valido(extra = {}) {
  return {
    id: crypto.randomUUID(),
    tiempo_ms: 8000,
    sitio_alterno: '',
    negocio: '  Tacos  El Güero ',
    contacto: 'Ana López',
    whatsapp: '+52 (631) 123-4567',
    email: 'Ana@Ejemplo.com',
    ciudad: 'Agua Prieta',
    web_redes: '@tacoselguero',
    mensaje: 'Hola,\r\nquiero información.',
    consentimiento: true,
    ...extra,
  };
}

async function enviar(cuerpo, { db = new FakeD1(), headers = {}, env = {}, fetchMock } = {}) {
  const request = new Request(ORIGEN + '/api/patrocinios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGEN, 'CF-Connecting-IP': '203.0.113.7', ...headers },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
  const llamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    llamadas.push({ url, body: JSON.parse(init.body) });
    return fetchMock ? fetchMock(url, init) : new Response('{"ok":true}', { status: 200 });
  };
  try {
    const res = await onRequestPost({ request, env: { DB: db, ...env } });
    return { res, body: await res.json(), db, llamadas };
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

test('guarda una solicitud válida con fecha, estado "Nuevo" y datos normalizados', async () => {
  const datos = valido();
  const { res, body, db, llamadas } = await enviar(datos);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, id: datos.id });

  const [fila] = db.filas();
  assert.equal(fila.id, datos.id);
  assert.equal(fila.estado, 'Nuevo');
  assert.match(fila.creado_en, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(fila.negocio, 'Tacos El Güero');
  assert.equal(fila.whatsapp, '+526311234567');
  assert.equal(fila.email, 'ana@ejemplo.com');
  assert.equal(fila.mensaje, 'Hola,\nquiero información.');
  assert.match(fila.consentimiento_texto, /^Autorizo que me contacten/);
  assert.match(fila.ip_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(fila.ip_hash, '203.0.113.7');
  assert.equal(fila.notificado, 1);

  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, 'https://formspree.io/f/xnjyoerk');
  assert.equal(llamadas[0].body._subject, 'Nueva solicitud de patrocinio: Tacos El Güero');
  assert.equal(llamadas[0].body._replyto, 'ana@ejemplo.com');
});

test('acepta opcionales vacíos', async () => {
  const { res, db } = await enviar(valido({ email: '', web_redes: '', mensaje: '' }));
  assert.equal(res.status, 200);
  const [fila] = db.filas();
  assert.equal(fila.email, null);
  assert.equal(fila.web_redes, null);
  assert.equal(fila.mensaje, null);
});

test('rechaza campos obligatorios vacíos y no guarda nada', async () => {
  const { res, body, db } = await enviar(valido({
    negocio: ' ', contacto: '', whatsapp: '', ciudad: '', consentimiento: false,
  }));
  assert.equal(res.status, 422);
  assert.deepEqual(Object.keys(body.errores).sort(), ['ciudad', 'consentimiento', 'contacto', 'negocio', 'whatsapp']);
  assert.throws(() => db.filas()); // ni siquiera se creó la tabla
});

test('exige código de país en WhatsApp', async () => {
  for (const whatsapp of ['6311234567', '+0 631 123 4567', '+52 63', '+52 631 ABC 4567']) {
    const { res, body } = await enviar(valido({ whatsapp }));
    assert.equal(res.status, 422, whatsapp);
    assert.ok(body.errores.whatsapp, whatsapp);
  }
  for (const whatsapp of ['+1 520 555 0100', '+52 631-123-4567']) {
    const { res } = await enviar(valido({ whatsapp }));
    assert.equal(res.status, 200, whatsapp);
  }
});

test('valida correo opcional y longitudes máximas', async () => {
  let r = await enviar(valido({ email: 'no-es-correo' }));
  assert.equal(r.res.status, 422);
  assert.ok(r.body.errores.email);

  r = await enviar(valido({ mensaje: 'x'.repeat(2001), negocio: 'n'.repeat(121) }));
  assert.equal(r.res.status, 422);
  assert.ok(r.body.errores.mensaje);
  assert.ok(r.body.errores.negocio);
});

test('la casilla de autorización es obligatoria', async () => {
  for (const consentimiento of [false, undefined, 'false', '']) {
    const { res, body } = await enviar(valido({ consentimiento }));
    assert.equal(res.status, 422);
    assert.ok(body.errores.consentimiento);
  }
});

test('antispam: campo trampa lleno o envío demasiado rápido', async () => {
  let r = await enviar(valido({ sitio_alterno: 'http://spam.example' }));
  assert.equal(r.res.status, 400);
  assert.throws(() => r.db.filas());

  r = await enviar(valido({ tiempo_ms: 500 }));
  assert.equal(r.res.status, 400);

  r = await enviar(valido({ tiempo_ms: undefined }));
  assert.equal(r.res.status, 400);
});

test('rechaza envíos desde otro origen y cuerpos inválidos', async () => {
  let r = await enviar(valido(), { headers: { Origin: 'https://otro-sitio.example' } });
  assert.equal(r.res.status, 403);

  r = await enviar('esto no es json');
  assert.equal(r.res.status, 400);
});

test('un reintento con el mismo folio no duplica ni vuelve a avisar', async () => {
  const db = new FakeD1();
  const datos = valido();
  const a = await enviar(datos, { db });
  const b = await enviar(datos, { db });
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.equal(b.body.id, datos.id);
  assert.equal(db.filas().length, 1);
  assert.equal(b.llamadas.length, 0);
});

test('limita a 5 solicitudes por hora desde la misma IP', async () => {
  const db = new FakeD1();
  for (let i = 0; i < 5; i++) {
    const { res } = await enviar(valido(), { db });
    assert.equal(res.status, 200);
  }
  const sexta = await enviar(valido(), { db });
  assert.equal(sexta.res.status, 429);
  const otraIp = await enviar(valido(), { db, headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal(otraIp.res.status, 200);
  assert.equal(db.filas().length, 6);
});

test('si el aviso falla, la solicitud se guarda igual con notificado = 0', async () => {
  const { res, db } = await enviar(valido(), {
    fetchMock: async () => new Response('error', { status: 500 }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.filas()[0].notificado, 0);
});

test('FORMSPREE_ENDPOINT=off desactiva el aviso', async () => {
  const { res, llamadas } = await enviar(valido(), { env: { FORMSPREE_ENDPOINT: 'off' } });
  assert.equal(res.status, 200);
  assert.equal(llamadas.length, 0);
});

test('sin base de datos configurada responde 503 (nunca simula guardar)', async () => {
  const request = new Request(ORIGEN + '/api/patrocinios', {
    method: 'POST', headers: { Origin: ORIGEN }, body: JSON.stringify(valido()),
  });
  const res = await onRequestPost({ request, env: {} });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
});

test('si la base falla al guardar responde 500 y ok: false', async () => {
  const db = new FakeD1();
  db.batch = async () => { throw new Error('D1 caído'); };
  const { res, body } = await enviar(valido(), { db });
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
});

test('el middleware oculta tests/, migrations/ y functions/ pero deja pasar /api', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const siguiente = async () => new Response('ok', { status: 200 });
  const estado = async ruta =>
    (await onRequest({ request: new Request(ORIGEN + ruta), next: siguiente })).status;
  for (const ruta of ['/tests/patrocinios.test.mjs', '/migrations/0001_solicitudes_patrocinio.sql',
    '/functions/api/patrocinios.js', '/TESTS/x', '/%74ests/x', '//tests/x', '/tests']) {
    assert.equal(await estado(ruta), 404, ruta);
  }
  for (const ruta of ['/api/patrocinios', '/patrocinios', '/testsx']) {
    assert.equal(await estado(ruta), 200, ruta);
  }
});
