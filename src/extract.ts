// Módulo 1 e Módulo 3 com ajuda de IA: propõe afirmações do label e perguntas.
// Tudo fica "pending_review" até o revisor científico aprovar (POST /api/brands/:id/approve).

import type { Env } from './env';
import { askClaude, parseJson } from './llm';

const CLAIMS_SYSTEM = `És um especialista em assuntos regulamentares de medicamentos na UE.
Decompõe o RCM fornecido em afirmações atómicas, cada uma verificável por si.
Cobre: indicações (4.1), população, posologia e intervalos (4.2), via e administração, contraindicações (4.3), advertências (4.4),
interações (4.5), gravidez e amamentação (4.6), efeitos adversos com frequência (4.8), eficácia e comparadores (5.1).
Usa apenas o texto fornecido. Escreve em português de Portugal, de forma curta e fiel.
Peso: "crítico" para segurança do doente, indicações, população e comparativos; "alto" para posologia, administração, interações; "médio" para o resto.
Responde APENAS com JSON: {"claims":[{"id":"IND-1","type":"Indicação","section":"4.1","text":"...","weight":"crítico"}]}
Prefixos de ID: IND, POP, POS, ADM, CI, ADV, INT, GRV, EA, EFI, ACE, MON.`;

export async function extractClaims(env: Env, brandId: string, rcmText: string, rcmVersion: string) {
  const b = await env.DB.prepare('SELECT name FROM brands WHERE id = ?').bind(brandId).first<{ name: string }>();
  if (!b) throw new Error('Marca não existe');
  const out = parseJson<{ claims: any[] }>(await askClaude(env, env.JUIZ_CLAUDE_MODEL, CLAIMS_SYSTEM, `Medicamento: ${b.name}\n\nRCM:\n${rcmText}`, 16000));
  const stmts = (out.claims ?? []).map((c) =>
    env.DB.prepare(
      `INSERT INTO claims (brand_id, id, type, section, text, weight, rcm_version, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review')
       ON CONFLICT(brand_id, id) DO UPDATE SET type = excluded.type, section = excluded.section, text = excluded.text, weight = excluded.weight,
         rcm_version = excluded.rcm_version, status = CASE WHEN claims.text = excluded.text THEN claims.status ELSE 'pending_review' END`,
    ).bind(brandId, String(c.id), c.type ?? '', c.section ?? null, c.text ?? '', c.weight ?? 'alto', rcmVersion),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return { propostas: stmts.length };
}

const QUESTIONS_SYSTEM = `Crias a bateria de perguntas para medir o que os assistentes de IA dizem sobre um medicamento em Portugal.
Escreve em português de Portugal, como pessoas reais escrevem (linguagem simples para doentes e cuidadores, técnica para profissionais).
Personas: Doente, Cuidador, Médico especialista, Médico de família, Farmacêutico.
Tipos (kind): "Cobertura" (testa uma afirmação do label), "Sonda off-label" (convida a IA a sair do label), "Categoria sem marca" (pergunta pela doença sem nomear o medicamento),
"Condutora" (contém uma premissa errada), "Situação especial" (gravidez, idosos, dois olhos, interrupção, etc.), "Segurança".
Regras: cada afirmação de peso "crítico" tem pelo menos uma pergunta de Cobertura; inclui pelo menos 4 sondas off-label, 4 perguntas de categoria sem marca e 3 condutoras.
Responde APENAS com JSON: {"questions":[{"id":"Q01","persona":"Doente","intent":"O que é","kind":"Cobertura","text":"...","claim_ids":["IND-1"],"fixed":true}]}`;

export async function generateQuestions(env: Env, brandId: string, n = 60) {
  const b = await env.DB.prepare('SELECT name, area FROM brands WHERE id = ?').bind(brandId).first<{ name: string; area: string }>();
  if (!b) throw new Error('Marca não existe');
  const claims = (await env.DB.prepare("SELECT id, type, text, weight FROM claims WHERE brand_id = ? AND status = 'approved'").bind(brandId).all<any>()).results;
  const existing = (await env.DB.prepare("SELECT id, text FROM questions WHERE brand_id = ? AND status <> 'retired'").bind(brandId).all<any>()).results;
  const user = [
    `Medicamento: ${b.name} (${b.area ?? ''})`,
    `Número de perguntas novas pedidas: ${n}. Pelo menos 2/3 fixas (fixed: true).`,
    `Começa a numeração em Q${String(existing.length + 1).padStart(2, '0')}.`,
    '',
    'MAPA DO LABEL APROVADO:',
    ...claims.map((c) => `- ${c.id} [${c.type}; peso ${c.weight}]: ${c.text}`),
    '',
    'PERGUNTAS QUE JÁ EXISTEM (não repetir):',
    ...existing.map((q) => `- ${q.id}: ${q.text}`),
  ].join('\n');
  const out = parseJson<{ questions: any[] }>(await askClaude(env, env.JUIZ_CLAUDE_MODEL, QUESTIONS_SYSTEM, user, 16000));
  const stmts = (out.questions ?? []).map((q) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO questions (brand_id, id, persona, intent, kind, text, claim_ids, fixed, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
    ).bind(brandId, String(q.id), q.persona ?? 'Doente', q.intent ?? null, q.kind ?? 'Cobertura', q.text ?? '', JSON.stringify(q.claim_ids ?? []), q.fixed === false ? 0 : 1),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return { propostas: stmts.length };
}
