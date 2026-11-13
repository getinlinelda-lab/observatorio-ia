-- Bloco 1: relatórios automáticos com link partilhável e protocolo de farmacovigilância.

-- Contacto do cliente para alertas de farmacovigilância (se vazio, usa ALERT_EMAIL).
ALTER TABLE brands ADD COLUMN alert_email TEXT;

-- Alertas de farmacovigilância: uma linha por frase sinalizada.
-- Entram as frases com categoria FV (possível evento adverso) e as de gravidade 4
-- (contradição com o RCM que pode levar a dano direto: nível 3 de desvio no documento técnico).
CREATE TABLE IF NOT EXISTS fv_alerts (
  id TEXT PRIMARY KEY,                 -- response_id:idx
  run_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  assistant TEXT NOT NULL,
  response_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  sentence TEXT NOT NULL,
  category TEXT,
  severity INTEGER NOT NULL,
  reason TEXT NOT NULL,                -- 'evento_adverso' | 'desvio_risco'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,
  notified_to TEXT,
  notify_error TEXT
);
CREATE INDEX IF NOT EXISTS fv_pending ON fv_alerts (notified_at);

-- Relatórios: um por recolha, com link público que pode ser desativado.
CREATE TABLE IF NOT EXISTS reports (
  share_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  brand_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked INTEGER NOT NULL DEFAULT 0
);
