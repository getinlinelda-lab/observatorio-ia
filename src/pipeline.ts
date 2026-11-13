// Os passos do mecanismo: recolher, avaliar, juntar, pontuar.
// Cada função é idempotente, para poder ser repetida por um Workflow sem duplicar dados.

import { ADAPTERS, ASSISTANT_LABELS } from './assistants';
import type { Citation, Env } from './env';
import { isFailure, judgePrompt, mergeSentence, runJudge, splitSentences, type JudgeOutput } from './judge';
import { mockCollect, mockJudge } from './mock';

const GLOBAL_OFFICIAL = ['ema.europa.eu', 'ec.europa.eu', 'infarmed.pt', 'sns.gov.pt', 'sns24.gov.pt', 'dgs.pt'];

const J = <T>(s: string | null | undefined, d: T): T => {
  try { return s ? (JSON.parse(s) as T) : d; } catch { return d; }
};

export const isOfficial = (domain: string, brandOfficial: string[]) =>
  [...GLOBAL_OFFICIAL, ...brandOfficial].some((d) => domain === d || domain.endsWith('.' + d));

export const domainType = (domain: string, brandOfficial: string[]) =>
  isOfficial(domain, brandOfficial) ? 'Oficial PT/UE' : domain.endsWith('.br') ? 'Brasil' : domain.endsWith('.gov') ? 'Governo EUA' : 'Outro';

async function brand(env: Env, brandId: string) {
  const b = await env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(brandId).first<any>();
  if (!b) throw new Error(`Marca ${brandId} não existe`);
  return { ...b, brand_terms: J<string[]>(b.brand_terms, []), official_domains: J<string[]>(b.official_domains, []) };
}

// ---------- Recolha ----------

export async function collect(env: Env, runId: string, brandId: string, questionId: string, assistant: string, rep: number): Promise<string> {
  const id = `${runId}:${questionId}:${assistant}:${rep}`;
  const exists = await env.DB.prepare('SELECT id FROM responses WHERE id = ? AND error IS NULL').bind(id).first();
  if (exists) return id;
  const q = await env.DB.prepare('SELECT text FROM questions WHERE brand_id = ? AND id = ?').bind(brandId, questionId).first<{ text: string }>();
  if (!q) throw new Error(`Pergunta ${questionId} não existe`);
  const adapter = ADAPTERS[assistant];
  if (!adapter) throw new Error(`Assistente sem API: ${assistant}`);
  const got = env.MODO_TESTE === '1' ? mockCollect(assistant, q.text, rep) : await adapter(env, q.text);
  const rawKey = `raw/${runId}/${questionId}/${assistant}/${rep}.json`;
  await env.PROVAS.put(rawKey, JSON.stringify({ question: q.text, collected_at: new Date().toISOString(), response: got.raw }), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO responses (id, run_id, brand_id, question_id, assistant, rep, method, model, text, citations, raw_key, error)
     VALUES (?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, NULL)`,
  ).bind(id, runId, brandId, questionId, assistant, rep, got.model, got.text, JSON.stringify(got.citations), rawKey).run();
  return id;
}

export async function recordFailure(env: Env, runId: string, brandId: string, questionId: string, assistant: string, rep: number, error: string) {
  const id = `${runId}:${questionId}:${assistant}:${rep}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO responses (id, run_id, brand_id, question_id, assistant, rep, method, error) VALUES (?, ?, ?, ?, ?, ?, 'api', ?)`,
  ).bind(id, runId, brandId, questionId, assistant, rep, error.slice(0, 1000)).run();
}

export async function storeManual(env: Env, body: { run_id: string; question_id: string; assistant: string; rep?: number; text: string; citations?: { url: string; title?: string }[]; model?: string }) {
  const run = await env.DB.prepare('SELECT brand_id FROM runs WHERE id = ?').bind(body.run_id).first<{ brand_id: string }>();
  if (!run) throw new Error('Recolha não existe');
  const rep = body.rep ?? 1;
  const id = `${body.run_id}:${body.question_id}:${body.assistant}:${rep}`;
  const { domainOf } = await import('./assistants');
  const cites: Citation[] = (body.citations ?? []).map((c) => ({ url: c.url, title: c.title, domain: domainOf(c.url, c.title) }));
  const rawKey = `raw/${body.run_id}/${body.question_id}/${body.assistant}/${rep}.json`;
  await env.PROVAS.put(rawKey, JSON.stringify({ ...body, collected_at: new Date().toISOString(), method: 'manual' }), { httpMetadata: { contentType: 'application/json' } });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO responses (id, run_id, brand_id, question_id, assistant, rep, method, model, text, citations, raw_key, error)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, NULL)`,
  ).bind(id, body.run_id, run.brand_id, body.question_id, body.assistant, rep, body.model ?? 'manual', body.text, JSON.stringify(cites), rawKey).run();
  return id;
}


// ---------- Métricas de uma resposta ----------
// Penalizações graduadas pela gravidade (0 a 4), em vez de "tudo ou nada":
// uma omissão ligeira de segurança não pode valer o mesmo que uma contraindicação omitida.
const FAILS = new Set(['incompleta', 'incorreta', 'off_label', 'comparativa_nao_suportada']);
type Sent = { status: string; category: string | null; severity: number };

export function computeMetrics(sents: Sent[], omittedSafety: boolean) {
  const judged = sents.filter((m) => m.status === 'correta' || FAILS.has(m.status)); // "não verificável" e "neutra" ficam de fora
  const correct = judged.reduce((a, m) => a + (m.status === 'correta' ? 1 : m.status === 'incompleta' ? 0.5 : 0), 0);
  const segPen = Math.max(0, omittedSafety ? 2 : 0, ...sents.filter((m) => m.category === 'SEG' && FAILS.has(m.status)).map((m) => m.severity));
  const olPen = Math.max(
    0,
    ...sents
      .filter((m) => m.status === 'off_label' || m.status === 'comparativa_nao_suportada' || (m.status === 'incorreta' && (m.category?.startsWith('OL-') || m.category === 'CMP')))
      .map((m) => m.severity),
  );
  return { evaluated: judged.length, correct, segPen, olPen };
}

// ---------- Avaliação ----------

async function context(env: Env, responseId: string) {
  const r = await env.DB.prepare('SELECT * FROM responses WHERE id = ?').bind(responseId).first<any>();
  if (!r) throw new Error('Resposta não existe');
  const b = await brand(env, r.brand_id);
  const claims = (await env.DB.prepare("SELECT id, type, section, text, weight FROM claims WHERE brand_id = ? AND status = 'approved' ORDER BY id").bind(r.brand_id).all<any>()).results;
  const q = await env.DB.prepare('SELECT * FROM questions WHERE brand_id = ? AND id = ?').bind(r.brand_id, r.question_id).first<any>();
  const citations = J<Citation[]>(r.citations, []);
  return { r, b, claims, q: { ...q, claim_ids: J<string[]>(q?.claim_ids, []) }, citations, sentences: splitSentences(r.text ?? '') };
}

export async function judge(env: Env, responseId: string, who: 'claude' | 'openai') {
  const done = await env.DB.prepare('SELECT 1 FROM judge_summaries WHERE response_id = ? AND judge = ?').bind(responseId, who).first();
  if (done) return;
  const c = await context(env, responseId);
  if (!c.sentences.length) return;
  const prompt = judgePrompt(c.b.name, c.claims, c.q, c.sentences, c.citations.map((x) => `${x.domain} — ${x.url}`), c.r.text ?? '');
  const out = env.MODO_TESTE === '1' ? mockJudge(prompt, who) : await runJudge(env, who, prompt);
  const stmts = out.sentences
    .filter((s) => s.idx >= 0 && s.idx < c.sentences.length)
    .map((s) =>
      env.DB.prepare(
        'INSERT OR REPLACE INTO evaluations (response_id, judge, idx, claim_id, status, category, severity, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(responseId, who, s.idx, s.claim_id, s.status, s.category, s.severity, s.rationale ?? ''),
    );
  stmts.push(
    env.DB.prepare('INSERT OR REPLACE INTO judge_summaries (response_id, judge, claims_covered, omitted_critical, promotional_tone) VALUES (?, ?, ?, ?, ?)')
      .bind(responseId, who, JSON.stringify(out.claims_covered), JSON.stringify(out.omitted_critical), out.promotional_tone ? 1 : 0),
  );
  await env.DB.batch(stmts);
}

const CAUSES = {
  mercado: { cause: 'Substituição de mercado', action: 'Criar conteúdo PT-PT em linguagem de doente, com sinais claros de localização' },
  vazio: { cause: 'Vazio de fonte oficial', action: 'Criar conteúdo-fonte oficial em português sobre este tema' },
  estrutura: { cause: 'Fonte oficial existe mas não é usada corretamente', action: 'Reestruturar a fonte oficial: FAQ, dados estruturados, títulos claros' },
  modelo: { cause: 'Erro do modelo sem fonte que o justifique', action: 'Registar, monitorizar e usar os canais de feedback do assistente' },
};

export function diagnose(citations: Citation[], official: string[]) {
  if (!citations.length) return CAUSES.modelo;
  const off = citations.filter((c) => isOfficial(c.domain, official)).length;
  if (off === 0 && citations.some((c) => c.domain.endsWith('.br'))) return CAUSES.mercado;
  if (off === 0) return CAUSES.vazio;
  return CAUSES.estrutura;
}

// Junta os juízes, grava o resultado por frase, as métricas da resposta e os achados.
export async function merge(env: Env, responseId: string, month: string) {
  const c = await context(env, responseId);
  const evals = (await env.DB.prepare('SELECT * FROM evaluations WHERE response_id = ?').bind(responseId).all<any>()).results;
  const sums = (await env.DB.prepare('SELECT * FROM judge_summaries WHERE response_id = ?').bind(responseId).all<any>()).results;
  const byJudge = (j: string) => new Map(evals.filter((e) => e.judge === j).map((e) => [e.idx, e]));
  const A = byJudge('claude');
  const B = byJudge('openai');
  const reviewed = new Map(
    (await env.DB.prepare('SELECT idx FROM sentences WHERE response_id = ? AND reviewed_by IS NOT NULL').bind(responseId).all<any>()).results.map((r) => [r.idx, true]),
  );

  const stmts: D1PreparedStatement[] = [];
  const merged: { idx: number; status: string; category: string | null; severity: number; claim_id: string | null }[] = [];
  c.sentences.forEach((text, idx) => {
    const a = A.get(idx), b = B.get(idx);
    if (!a && !b) return;
    const m = mergeSentence(a, b);
    merged.push({ idx, status: m.status, category: m.category, severity: m.severity, claim_id: m.claim_id });
    if (reviewed.get(idx)) return; // a decisão do revisor prevalece
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO sentences (response_id, idx, sentence, claim_id, status, category, severity, agreed, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(responseId, idx, text, m.claim_id, m.status, m.category, m.severity, m.agreed, m.needs_review),
    );
  });

  // Só conta o que os dois juízes concordam (com um só juiz disponível, conta o dele).
  const agreedOn = (field: 'claims_covered' | 'omitted_critical') => {
    const sets = sums.map((s) => new Set(J<string[]>(s[field], [])));
    return sets.length ? [...sets[0]].filter((id) => sets.every((s) => s.has(id))) : [];
  };
  const covered = new Set<string>(agreedOn('claims_covered'));
  const omitted = agreedOn('omitted_critical');
  const officialN = c.citations.filter((x) => isOfficial(x.domain, c.b.official_domains)).length;
  const text = (c.r.text ?? '').toLowerCase();
  const mentioned = c.b.brand_terms.some((t: string) => t && text.includes(t.toLowerCase())) ? 1 : 0;

  const omittedSafety = omitted.some((id) => c.claims.find((x: any) => x.id === id && /Contraindica|Advert/.test(x.type)));
  const mx = computeMetrics(merged, omittedSafety);
  stmts.push(
    env.DB.prepare(
      `INSERT OR REPLACE INTO response_metrics (response_id, evaluated, correct, has_seg, has_offlabel, claims_expected, claims_covered, brand_mentioned, official_citations, total_citations, promotional_tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      responseId,
      mx.evaluated,
      mx.correct,
      mx.segPen,
      mx.olPen,
      JSON.stringify(c.q.claim_ids),
      JSON.stringify([...covered]),
      mentioned,
      officialN,
      c.citations.length,
      sums.some((s) => s.promotional_tone) ? 1 : 0,
    ),
  );

  // Achados: uma linha por pergunta × assistente × categoria × afirmação, com primeira e última data em que surgiu.
  const dx = diagnose(c.citations, c.b.official_domains);
  const fails = merged.filter((m) => m.category && (isFailure(m.status) || m.severity > 0));
  const items = [
    ...fails.map((m) => ({ category: m.category!, claim: m.claim_id, severity: m.severity, example: c.sentences[m.idx] })),
    ...omitted.map((id) => ({ category: 'OMI', claim: id, severity: 2, example: `Omite a afirmação ${id} do label` })),
  ];
  for (const f of items) {
    const key = [c.r.brand_id, c.r.question_id, c.r.assistant, f.category, f.claim ?? '-'].join('|');
    stmts.push(
      env.DB.prepare(
        `INSERT INTO findings (key, brand_id, question_id, assistant, category, claim_id, severity, example, cause, action, first_seen, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
         ON CONFLICT(key) DO UPDATE SET severity = MAX(findings.severity, excluded.severity), example = excluded.example,
           cause = excluded.cause, action = excluded.action, last_seen = excluded.last_seen, status = 'open'`,
      ).bind(key, c.r.brand_id, c.r.question_id, c.r.assistant, f.category, f.claim, f.severity, f.example.slice(0, 500), dx.cause, dx.action, month, month),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// Recalcula as métricas de uma resposta a partir das frases finais (depois de uma revisão ou de um recálculo).
export async function refreshMetrics(env: Env, responseId: string) {
  const sents = (await env.DB.prepare('SELECT status, category, severity FROM sentences WHERE response_id = ?').bind(responseId).all<Sent>()).results;
  const r = await env.DB.prepare('SELECT brand_id FROM responses WHERE id = ?').bind(responseId).first<{ brand_id: string }>();
  const sums = (await env.DB.prepare('SELECT omitted_critical FROM judge_summaries WHERE response_id = ?').bind(responseId).all<any>()).results;
  const sets = sums.map((s) => new Set(J<string[]>(s.omitted_critical, [])));
  const omitted = sets.length ? [...sets[0]].filter((id) => sets.every((x) => x.has(id))) : [];
  let omittedSafety = false;
  if (omitted.length && r) {
    const safe = (await env.DB.prepare("SELECT id FROM claims WHERE brand_id = ? AND (type LIKE 'Contraindica%' OR type LIKE 'Advert%')").bind(r.brand_id).all<{ id: string }>()).results.map((x) => x.id);
    omittedSafety = omitted.some((id) => safe.includes(id));
  }
  const mx = computeMetrics(sents, omittedSafety);
  await env.DB.prepare('UPDATE response_metrics SET evaluated = ?, correct = ?, has_seg = ?, has_offlabel = ? WHERE response_id = ?')
    .bind(mx.evaluated, mx.correct, mx.segPen, mx.olPen, responseId).run();
}

// ---------- Progresso e índice ----------

export async function markDone(env: Env, runId: string): Promise<{ done: number; total: number }> {
  const r = await env.DB.prepare('UPDATE runs SET done_tasks = done_tasks + 1 WHERE id = ? RETURNING done_tasks, total_tasks').bind(runId).first<any>();
  return { done: r?.done_tasks ?? 0, total: r?.total_tasks ?? 0 };
}

const WEIGHTS = { exatidao: 0.3, seguranca: 0.25, conformidade: 0.15, completude: 0.1, autoridade: 0.1, consistencia: 0.05, presenca: 0.05 };
type Comp = Record<keyof typeof WEIGHTS, number | null>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a), B = new Set(b);
  const u = new Set([...A, ...B]);
  if (!u.size) return 1;
  return [...A].filter((x) => B.has(x)).length / u.size;
};

export function components(rows: any[]): Comp {
  const ev = rows.reduce((a, r) => a + r.evaluated, 0);
  const cor = rows.reduce((a, r) => a + r.correct, 0);
  const tot = rows.reduce((a, r) => a + r.total_citations, 0);
  const off = rows.reduce((a, r) => a + r.official_citations, 0);
  const compl = rows
    .map((r) => {
      const exp = J<string[]>(r.claims_expected, []);
      if (!exp.length) return null;
      const cov = new Set(J<string[]>(r.claims_covered, []));
      return exp.filter((x) => cov.has(x)).length / exp.length;
    })
    .filter((x): x is number => x !== null);
  const groups = new Map<string, string[][]>();
  rows.forEach((r) => {
    const k = `${r.question_id}|${r.assistant}`;
    groups.set(k, [...(groups.get(k) ?? []), J<string[]>(r.claims_covered, [])]);
  });
  const cons: number[] = [];
  groups.forEach((sets) => {
    if (sets.length < 2) return;
    const pairs: number[] = [];
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) pairs.push(jaccard(sets[i], sets[j]));
    cons.push(mean(pairs)!);
  });
  const cat = rows.filter((r) => r.kind === 'Categoria sem marca');
  return {
    exatidao: ev ? cor / ev : null,
    seguranca: rows.length ? 1 - mean(rows.map((r) => Number(r.has_seg)))! / 4 : null, // has_seg = penalização 0–4
    conformidade: rows.length ? 1 - mean(rows.map((r) => Number(r.has_offlabel)))! / 4 : null, // has_offlabel = penalização 0–4
    completude: mean(compl),
    // Sem fontes citadas, a autoridade é 0: nada do que a marca publica influencia a resposta.
    autoridade: rows.length ? (tot ? off / tot : 0) : null,
    consistencia: mean(cons),
    presenca: cat.length ? mean(cat.map((r) => r.brand_mentioned)) : null,
  };
}

export function indexOf(c: Comp): number | null {
  let w = 0, s = 0;
  (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).forEach((k) => {
    const v = c[k];
    if (v !== null && !Number.isNaN(v)) { w += WEIGHTS[k]; s += WEIGHTS[k] * v; }
  });
  return w ? Math.round((s / w) * 1000) / 10 : null;
}

export async function score(env: Env, runId: string) {
  const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<any>();
  if (!run) return;
  const b = await brand(env, run.brand_id);
  const rows = (
    await env.DB.prepare(
      `SELECT m.*, r.assistant, r.question_id, q.persona, q.kind
       FROM response_metrics m JOIN responses r ON r.id = m.response_id
       JOIN questions q ON q.brand_id = r.brand_id AND q.id = r.question_id
       WHERE r.run_id = ? AND r.error IS NULL AND q.variant_of IS NULL`,
    ).bind(runId).all<any>()
  ).results;
  if (!rows.length) return;
  // As variantes de contexto ("Sou oftalmologista…") ficam fora do índice principal; o relatório compara-as à parte.

  const assistants = ['global', ...new Set(rows.map((r) => r.assistant))];
  const personas = ['todas', ...new Set(rows.map((r) => r.persona))];
  const stmts: D1PreparedStatement[] = [];
  for (const a of assistants) {
    for (const p of personas) {
      const sub = rows.filter((r) => (a === 'global' || r.assistant === a) && (p === 'todas' || r.persona === p));
      if (!sub.length) continue;
      const c = components(sub);
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO index_monthly (run_id, brand_id, month, assistant, persona, responses, exatidao, seguranca, conformidade, completude, autoridade, consistencia, presenca, indice, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).bind(runId, run.brand_id, run.month, a, p, sub.length, c.exatidao, c.seguranca, c.conformidade, c.completude, c.autoridade, c.consistencia, c.presenca, indexOf(c)),
      );
    }
  }

  // Achados que não voltaram a aparecer neste mês, nos assistentes recolhidos, passam a resolvidos.
  // Só numa recolha completa: um teste com poucas perguntas não pode dar por resolvido o que não voltou a perguntar.
  const collected = [...new Set(rows.map((r) => r.assistant))];
  if (!runId.includes('-teste-')) stmts.push(
    env.DB.prepare(
      `UPDATE findings SET status = 'resolved' WHERE brand_id = ? AND status = 'open' AND last_seen < ? AND assistant IN (SELECT value FROM json_each(?))`,
    ).bind(run.brand_id, run.month, JSON.stringify(collected)),
  );
  await env.DB.batch(stmts);

  // Registo de fontes (base de conhecimento): conta cada recolha uma única vez.
  if (!run.sources_counted && run.status === 'complete') {
    const resp = (await env.DB.prepare('SELECT citations FROM responses WHERE run_id = ? AND error IS NULL').bind(runId).all<any>()).results;
    const count = new Map<string, number>();
    resp.forEach((r) => J<Citation[]>(r.citations, []).forEach((c) => count.set(c.domain, (count.get(c.domain) ?? 0) + 1)));
    const up = [...count].map(([d, n]) =>
      env.DB.prepare(
        `INSERT INTO sources_registry (domain, type, times_cited, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET times_cited = sources_registry.times_cited + excluded.times_cited, last_seen = excluded.last_seen`,
      ).bind(d, domainType(d, b.official_domains), n, run.month, run.month),
    );
    up.push(env.DB.prepare('UPDATE runs SET sources_counted = 1 WHERE id = ?').bind(runId));
    await env.DB.batch(up);
  }
}

export async function completeIfDone(env: Env, runId: string, p: { done: number; total: number }) {
  let closed = false;
  if (p.total && p.done >= p.total) {
    const r = await env.DB.prepare("UPDATE runs SET status = 'complete', finished_at = datetime('now') WHERE id = ? AND status <> 'complete' RETURNING id").bind(runId).first();
    closed = !!r; // só a última pergunta a terminar fecha a recolha e publica o relatório
  }
  await score(env, runId);
  if (closed) {
    const { publishReport } = await import('./report');
    await publishReport(env, runId).catch((e) => console.error('Relatório falhou:', e));
  }
}

export const labelOf = (a: string) => ASSISTANT_LABELS[a] ?? a;
export type { JudgeOutput };
