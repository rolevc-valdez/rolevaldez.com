// Cloudflare Pages Function: POST /api/patrocinios
// Guarda solicitudes de patrocinio en D1 (binding "DB") y avisa por Formspree.

const CONSENTIMIENTO =
  'Autorizo que me contacten para recibir información sobre el patrocinio del podcast Dando un Rol con el Role.';

const FORMSPREE_DEFAULT = 'https://formspree.io/f/xnjyoerk'; // mismo formulario que usa #contacto
const TIEMPO_MINIMO_MS  = 2500;  // envíos más rápidos que esto se tratan como bot
const LIMITE_POR_HORA   = 5;     // solicitudes por IP por hora

const LIMITES = {
  negocio: 120, contacto: 120, whatsapp: 25, email: 160,
  ciudad: 80, web_redes: 200, mensaje: 2000,
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS solicitudes_patrocinio (
    id TEXT PRIMARY KEY,
    creado_en TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'Nuevo',
    negocio TEXT NOT NULL,
    contacto TEXT NOT NULL,
    whatsapp TEXT NOT NULL,
    email TEXT,
    ciudad TEXT NOT NULL,
    web_redes TEXT,
    mensaje TEXT,
    consentimiento_texto TEXT NOT NULL,
    consentimiento_en TEXT NOT NULL,
    ip_hash TEXT,
    user_agent TEXT,
    notificado INTEGER NOT NULL DEFAULT 0,
    notas TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_patrocinio_ip_fecha ON solicitudes_patrocinio (ip_hash, creado_en)`,
];

const conSchema = new WeakSet();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function texto(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function textoLargo(v) {
  // Conserva saltos de línea en el mensaje, pero normaliza el resto.
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim() : '';
}

function validar(datos) {
  const errores = {};
  const limpio = {
    negocio:   texto(datos.negocio),
    contacto:  texto(datos.contacto),
    whatsapp:  texto(datos.whatsapp),
    email:     texto(datos.email).toLowerCase(),
    ciudad:    texto(datos.ciudad),
    web_redes: texto(datos.web_redes),
    mensaje:   textoLargo(datos.mensaje),
  };

  if (!limpio.negocio)  errores.negocio  = 'Escribe el nombre del negocio.';
  if (!limpio.contacto) errores.contacto = 'Escribe el nombre de la persona de contacto.';
  if (!limpio.ciudad)   errores.ciudad   = 'Escribe la ciudad.';

  if (!limpio.whatsapp) {
    errores.whatsapp = 'Escribe tu número de WhatsApp con código de país.';
  } else {
    const digitos = limpio.whatsapp.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(digitos)) {
      errores.whatsapp = 'Incluye el código de país, por ejemplo +52 631 123 4567.';
    } else {
      limpio.whatsapp = digitos;
    }
  }

  if (limpio.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(limpio.email)) {
    errores.email = 'Revisa el correo electrónico.';
  }

  for (const [campo, max] of Object.entries(LIMITES)) {
    if (!errores[campo] && limpio[campo].length > max) {
      errores[campo] = `Máximo ${max} caracteres.`;
    }
  }

  if (datos.consentimiento !== true && datos.consentimiento !== 'on' && datos.consentimiento !== 'true') {
    errores.consentimiento = 'Necesitamos tu autorización para contactarte.';
  }

  return { limpio, errores };
}

async function hashIp(ip, sal) {
  if (!ip) return null;
  const bytes = new TextEncoder().encode((sal || 'rolevaldez-patrocinios') + '|' + ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function asegurarSchema(db) {
  if (conSchema.has(db)) return;
  await db.batch(SCHEMA.map(sql => db.prepare(sql)));
  conSchema.add(db);
}

async function notificar(env, db, id, s) {
  const endpoint = env.FORMSPREE_ENDPOINT || FORMSPREE_DEFAULT;
  if (endpoint === 'off') return;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: `Nueva solicitud de patrocinio: ${s.negocio}`,
        ...(s.email ? { _replyto: s.email } : {}),
        tipo: 'Patrocinio del podcast',
        negocio: s.negocio,
        contacto: s.contacto,
        whatsapp: s.whatsapp,
        email: s.email || '(no proporcionado)',
        ciudad: s.ciudad,
        web_redes: s.web_redes || '(no proporcionado)',
        mensaje: s.mensaje || '(sin mensaje)',
        folio: id,
      }),
    });
    if (!res.ok) throw new Error('Formspree respondió ' + res.status);
    await db.prepare('UPDATE solicitudes_patrocinio SET notificado = 1 WHERE id = ?').bind(id).run();
  } catch (err) {
    console.error('[patrocinios] aviso no enviado', id, err && err.message);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) {
    console.error('[patrocinios] falta el binding D1 "DB"');
    return json({ ok: false, error: 'El formulario no está disponible por el momento. Intenta más tarde.' }, 503);
  }

  // Solo aceptamos envíos desde el propio sitio.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: 'Origen no permitido.' }, 403);
  }

  let datos;
  try {
    datos = await request.json();
  } catch {
    return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  }
  if (!datos || typeof datos !== 'object') {
    return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  }

  // Antispam básico: campo trampa y tiempo mínimo de llenado.
  if (texto(datos.sitio_alterno) || !(Number(datos.tiempo_ms) >= TIEMPO_MINIMO_MS)) {
    return json({ ok: false, error: 'No pudimos procesar tu solicitud. Revisa tus datos e intenta de nuevo.' }, 400);
  }

  const { limpio, errores } = validar(datos);
  if (Object.keys(errores).length) {
    return json({ ok: false, error: 'Revisa los campos marcados.', errores }, 422);
  }

  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(datos.id || '')
    ? datos.id.toLowerCase()
    : crypto.randomUUID();
  const ahora = new Date().toISOString();
  const ipHash = await hashIp(request.headers.get('CF-Connecting-IP'), env.IP_SALT);
  const db = env.DB;

  try {
    await asegurarSchema(db);

    // Reintento de una solicitud ya guardada: confirmar sin duplicar ni volver a avisar.
    const existente = await db.prepare('SELECT id FROM solicitudes_patrocinio WHERE id = ?').bind(id).first();
    if (existente) return json({ ok: true, id });

    if (ipHash) {
      const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
      const fila = await db
        .prepare('SELECT COUNT(*) AS n FROM solicitudes_patrocinio WHERE ip_hash = ? AND creado_en > ?')
        .bind(ipHash, haceUnaHora)
        .first();
      if (fila && fila.n >= LIMITE_POR_HORA) {
        return json({ ok: false, error: 'Recibimos varias solicitudes desde tu conexión. Intenta más tarde.' }, 429);
      }
    }

    const res = await db
      .prepare(
        `INSERT INTO solicitudes_patrocinio
          (id, creado_en, estado, negocio, contacto, whatsapp, email, ciudad, web_redes, mensaje,
           consentimiento_texto, consentimiento_en, ip_hash, user_agent)
         VALUES (?, ?, 'Nuevo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        id, ahora, limpio.negocio, limpio.contacto, limpio.whatsapp, limpio.email || null,
        limpio.ciudad, limpio.web_redes || null, limpio.mensaje || null,
        CONSENTIMIENTO, ahora, ipHash, (request.headers.get('User-Agent') || '').slice(0, 300)
      )
      .run();

    if (res.meta && res.meta.changes > 0) {
      const aviso = notificar(env, db, id, limpio);
      if (context.waitUntil) context.waitUntil(aviso); else await aviso;
    }
    return json({ ok: true, id });
  } catch (err) {
    console.error('[patrocinios] error al guardar', err && err.message);
    return json({ ok: false, error: 'No pudimos guardar tu solicitud. Intenta de nuevo.' }, 500);
  }
}
