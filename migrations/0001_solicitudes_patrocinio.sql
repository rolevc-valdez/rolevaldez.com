-- Tabla de solicitudes de patrocinio (Cloudflare D1, binding "DB").
-- functions/api/patrocinios.js la crea automáticamente si no existe;
-- este archivo sirve para crearla a mano o con:
--   npx wrangler d1 execute patrocinios --remote --file migrations/0001_solicitudes_patrocinio.sql

CREATE TABLE IF NOT EXISTS solicitudes_patrocinio (
  id TEXT PRIMARY KEY,
  creado_en TEXT NOT NULL,              -- ISO 8601 en UTC
  estado TEXT NOT NULL DEFAULT 'Nuevo', -- Nuevo, Contactado, Cerrado, etc.
  negocio TEXT NOT NULL,
  contacto TEXT NOT NULL,
  whatsapp TEXT NOT NULL,               -- normalizado, ej. +526311234567
  email TEXT,
  ciudad TEXT NOT NULL,
  web_redes TEXT,
  mensaje TEXT,
  consentimiento_texto TEXT NOT NULL,
  consentimiento_en TEXT NOT NULL,
  ip_hash TEXT,                         -- SHA-256 de la IP, solo para limitar envíos
  user_agent TEXT,
  notificado INTEGER NOT NULL DEFAULT 0, -- 1 si el aviso por Formspree se envió
  notas TEXT
);

CREATE INDEX IF NOT EXISTS idx_patrocinio_ip_fecha ON solicitudes_patrocinio (ip_hash, creado_en);
