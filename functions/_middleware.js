// Evita que se sirvan como archivos estáticos las carpetas internas del repo.
// _routes.json limita este middleware a /api/* y a estas rutas, así el resto
// del sitio sigue siendo estático y no consume invocaciones de Functions.
const PRIVADAS = ['/tests/', '/migrations/', '/functions/'];

export async function onRequest({ request, next }) {
  let ruta = new URL(request.url).pathname;
  try { ruta = decodeURIComponent(ruta); } catch { /* ruta mal codificada: se evalúa tal cual */ }
  ruta = ruta.toLowerCase().replace(/\/{2,}/g, '/');
  if (PRIVADAS.some(p => ruta.startsWith(p) || ruta + '/' === p)) {
    return new Response('No encontrado', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return next();
}
