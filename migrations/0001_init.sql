-- Observatório IA — esquema inicial
-- Tudo é datado e nada é apagado: é isto que constrói o histórico.

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  substance TEXT,
  holder TEXT,
  area TEXT,
  brand_terms TEXT NOT NULL DEFAULT '[]',      -- JSON: nomes que contam como menção da marca
  official_domains TEXT NOT NULL DEFAULT '[]', -- JSON: domínios oficiais desta marca (ex.: RCM do titular)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Módulo 1: mapa do label (afirmações atómicas do RCM)
CREATE TABLE IF NOT EXISTS claims (
  brand_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  weight TEXT NOT NULL DEFAULT 'alto',          -- crítico | alto | médio
  rcm_version TEXT,
  status TEXT NOT NULL DEFAULT 'approved',      -- approved | pending_review | retired
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brand_id, id)
);

-- Módulo 3: bateria de perguntas
CREATE TABLE IF NOT EXISTS questions (
  brand_id TEXT NOT NULL,
  id TEXT NOT NULL,
  persona TEXT NOT NULL,
  intent TEXT,
  kind TEXT,                                    -- Cobertura | Sonda off-label | Categoria sem marca | Condutora | ...
  text TEXT NOT NULL,
  claim_ids TEXT NOT NULL DEFAULT '[]',         -- JSON
  fixed INTEGER NOT NULL DEFAULT 1,             -- 1 = fixa (série histórica), 0 = rotativa
  status TEXT NOT NULL DEFAULT 'approved',      -- approved | pending_review | retired
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (brand_id, id)
);

-- Módulo 4: recolhas
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  month TEXT NOT NULL,                          -- AAAA-MM
  status TEXT NOT NULL DEFAULT 'running',       -- running | complete
  total_tasks INTEGER NOT NULL DEFAULT 0,
  done_tasks INTEGER NOT NULL DEFAULT 0,
  sources_counted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_brand_month ON runs (brand_id, month);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  assistant TEXT NOT NULL,
  rep INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'api',           -- api | manual
  model TEXT,
  text TEXT,
  citations TEXT NOT NULL DEFAULT '[]',         -- JSON: [{url, title, domain}]
  raw_key TEXT,                                 -- chave da resposta completa no R2
  error TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, question_id, assistant, rep)
);
CREATE INDEX IF NOT EXISTS responses_run ON responses (run_id);

-- Módulo 5: avaliação de cada juiz, frase a frase
CREATE TABLE IF NOT EXISTS evaluations (
  response_id TEXT NOT NULL,
  judge TEXT NOT NULL,                          -- claude | openai
  idx INTEGER NOT NULL,
  claim_id TEXT,
  status TEXT NOT NULL,
  category TEXT,
  severity INTEGER NOT NULL DEFAULT 0,
  rationale TEXT,
  PRIMARY KEY (response_id, judge, idx)
);

CREATE TABLE IF NOT EXISTS judge_summaries (
  response_id TEXT NOT NULL,
  judge TEXT NOT NULL,
  claims_covered TEXT NOT NULL DEFAULT '[]',
  omitted_critical TEXT NOT NULL DEFAULT '[]',
  promotional_tone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (response_id, judge)
);

-- Resultado final por frase (acordo dos juízes ou decisão do revisor)
CREATE TABLE IF NOT EXISTS sentences (
  response_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  sentence TEXT NOT NULL,
  claim_id TEXT,
  status TEXT NOT NULL,
  category TEXT,
  severity INTEGER NOT NULL DEFAULT 0,
  agreed INTEGER NOT NULL DEFAULT 1,
  needs_review INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at TEXT,
  PRIMARY KEY (response_id, idx)
);
CREATE INDEX IF NOT EXISTS sentences_review ON sentences (needs_review);

CREATE TABLE IF NOT EXISTS response_metrics (
  response_id TEXT PRIMARY KEY,
  evaluated INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  has_seg INTEGER NOT NULL DEFAULT 0,
  has_offlabel INTEGER NOT NULL DEFAULT 0,
  claims_expected TEXT NOT NULL DEFAULT '[]',
  claims_covered TEXT NOT NULL DEFAULT '[]',
  brand_mentioned INTEGER NOT NULL DEFAULT 0,
  official_citations INTEGER NOT NULL DEFAULT 0,
  total_citations INTEGER NOT NULL DEFAULT 0,
  promotional_tone INTEGER NOT NULL DEFAULT 0
);

-- Índice de Saúde da Marca na IA, por recolha, assistente e persona
CREATE TABLE IF NOT EXISTS index_monthly (
  run_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  month TEXT NOT NULL,
  assistant TEXT NOT NULL,                      -- nome do assistente ou 'global'
  persona TEXT NOT NULL,                        -- persona ou 'todas'
  responses INTEGER NOT NULL,
  exatidao REAL, seguranca REAL, conformidade REAL, completude REAL,
  autoridade REAL, consistencia REAL, presenca REAL,
  indice REAL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, assistant, persona)
);

-- Módulo 6: achados, com histórico de quando surgem e desaparecem
CREATE TABLE IF NOT EXISTS findings (
  key TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  assistant TEXT NOT NULL,
  category TEXT NOT NULL,
  claim_id TEXT,
  severity INTEGER NOT NULL,
  example TEXT,
  cause TEXT,
  action TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'           -- open | resolved
);
CREATE INDEX IF NOT EXISTS findings_brand ON findings (brand_id, status);

-- Módulo 7: base de conhecimento partilhada (sem dados confidenciais de clientes)
CREATE TABLE IF NOT EXISTS sources_registry (
  domain TEXT PRIMARY KEY,
  type TEXT,
  trust TEXT,
  times_cited INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_patterns (
  pattern TEXT PRIMARY KEY,
  description TEXT,
  fix TEXT,
  area TEXT,
  first_seen TEXT NOT NULL DEFAULT (date('now'))
);
