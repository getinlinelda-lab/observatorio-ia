// Observatório IA — Worker principal: API, agendamento mensal e exportação para o dashboard.

import type { Env } from './env';
import { list } from './env';
import { extractClaims, generateQuestions } from './extract';
import { SEVERITY_LABEL } from './judge';
import { labelOf, refreshMetrics, score, storeManual } from './pipeline';
import { buildReport, publishReport, renderReport } from './report';
import { notifyFv } from './notify';
import { MANUAL_HTML } from './manual';

export { EvalWorkflow, QuestionWorkflow } from './workflows';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const thisMonth = () => new Date().toISOString().slice(0, 7);

function authorized(req: Request, env: Env, write: boolean): boolean {
  const h = req.headers.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || !env.API_TOKEN) return false;
  if (token === env.API_TOKEN) return true;
  return !write && !!env.READ_TOKEN && token === env.READ_TOKEN;
}

// Arranca a recolha de uma marca: cria a recolha e uma instância de Workflow por pergunta aprovada.
// Para testes: question_ids limita as perguntas e reps substitui o número de repetições.
async function startRun(env: Env, brandId: string, month = thisMonth(), opts: { question_ids?: string[]; reps?: number } = {}) {
  let qs = (await env.DB.prepare("SELECT id FROM questions WHERE brand_id = ? AND status = 'approved' ORDER BY id").bind(brandId).all<{ id: string }>()).results;
  if (opts.question_ids?.length) qs = qs.filter((q) => opts.question_ids!.includes(q.id));
  if (!qs.length) throw new Error(`A marca ${brandId} não tem perguntas aprovadas${opts.question_ids?.length ? ' com esses IDs' : ''}`);
  const runId = `${brandId}-${month}-${opts.question_ids?.length ? 'teste-' : ''}${Date.now().toString(36)}`;
  await env.DB.prepare('INSERT INTO runs (id, brand_id, month, total_tasks) VALUES (?, ?, ?, ?)').bind(runId, brandId, month, qs.length).run();
  // Só entram os assistentes com chave configurada; os outros ficam registados como em falta.
  const keyFor: Record<string, string | undefined> = { chatgpt: env.OPENAI_API_KEY, gemini: env.GEMINI_API_KEY, perplexity: env.PERPLEXITY_API_KEY, claude: env.ANTHROPIC_API_KEY };
  const configured = list(env.ASSISTENTES_API);
  const assistants = configured.filter((a) => !!keyFor[a] || env.MODO_TESTE === '1');
  const semChave = configured.filter((a) => !assistants.includes(a));
  if (!assistants.length) throw new Error(`Nenhum assistente com chave de API configurada (${configured.join(', ')}). Ver README, passo 5.`);
  const reps = Math.max(1, Math.min(5, Number(opts.reps) || Number(env.REPETICOES) || 3));
  for (let i = 0; i < qs.length; i += 100) {
    const chunk = qs.slice(i, i + 100);
    await env.QUESTION_WORKFLOW.createBatch({
      instances: chunk.map((q) => ({ id: `${runId}-${q.id}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100), params: { runId, brandId, questionId: q.id, assistants, reps } })),
    } as any);
  }
  return { run_id: runId, perguntas: qs.length, assistentes_api: assistants, sem_chave: semChave, repeticoes: reps };
}

async function upsertBrand(env: Env, body: any) {
  if (!body?.id || !body?.name) throw new Error('Faltam id e name');
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO brands (id, name, substance, holder, area, brand_terms, official_domains, alert_email, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, substance = excluded.substance, holder = excluded.holder, area = excluded.area,
         brand_terms = excluded.brand_terms, official_domains = excluded.official_domains, alert_email = COALESCE(excluded.alert_email, brands.alert_email)`,
    ).bind(body.id, body.name, body.substance ?? null, body.holder ?? null, body.area ?? null, JSON.stringify(body.brand_terms ?? [body.name]), JSON.stringify(body.official_domains ?? []), body.alert_email ?? null),
  ];
  for (const c of body.claims ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO claims (brand_id, id, type, section, text, weight, rcm_version, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(body.id, c.id, c.type, c.section ?? null, c.text, c.weight ?? 'alto', c.rcm_version ?? null, c.status ?? 'approved'),
    );
  }
  for (const q of body.questions ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO questions (brand_id, id, persona, intent, kind, text, claim_ids, fixed, status, variant_of, framing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(body.id, q.id, q.persona, q.intent ?? null, q.kind ?? null, q.text, JSON.stringify(q.claim_ids ?? []), q.fixed === false ? 0 : 1, q.status ?? 'approved', q.variant_of ?? null, q.framing ?? null),
    );
  }
  await env.DB.batch(stmts);
  return { marca: body.id, afirmacoes: (body.claims ?? []).length, perguntas: (body.questions ?? []).length };
}

// Dados no formato dos datasets do dashboard (um ficheiro JSON por dataset).
async function exportBrand(env: Env, brandId: string) {
  const idx = (
    await env.DB.prepare(
      `SELECT i.month, i.assistant, i.indice FROM index_monthly i
       JOIN (SELECT month, MAX(started_at) s FROM runs WHERE brand_id = ? GROUP BY month) last ON last.month = i.month
       JOIN runs r ON r.id = i.run_id AND r.started_at = last.s
       WHERE i.brand_id = ? AND i.persona = 'todas' AND i.assistant <> 'global' ORDER BY i.month, i.assistant`,
    ).bind(brandId, brandId).all<any>()
  ).results;
  const alerts = (
    await env.DB.prepare(
      `SELECT ru.month, s.severity, COUNT(*) n FROM sentences s JOIN responses r ON r.id = s.response_id JOIN runs ru ON ru.id = r.run_id
       WHERE r.brand_id = ? AND s.severity > 0 GROUP BY ru.month, s.severity ORDER BY ru.month`,
    ).bind(brandId).all<any>()
  ).results;
  const findings = (
    await env.DB.prepare(
      `SELECT f.*, q.text AS question_text FROM findings f LEFT JOIN questions q ON q.brand_id = f.brand_id AND q.id = f.question_id
       WHERE f.brand_id = ? ORDER BY f.status, f.severity DESC, f.last_seen DESC`,
    ).bind(brandId).all<any>()
  ).results;
  const claims = (await env.DB.prepare("SELECT id, type, section, text, weight FROM claims WHERE brand_id = ? AND status = 'approved' ORDER BY id").bind(brandId).all<any>()).results;
  const questions = (await env.DB.prepare("SELECT id, persona, intent, kind, text, claim_ids FROM questions WHERE brand_id = ? AND status = 'approved' ORDER BY id").bind(brandId).all<any>()).results;
  const sources = (await env.DB.prepare('SELECT domain, type, trust, times_cited, first_seen, last_seen FROM sources_registry ORDER BY times_cited DESC LIMIT 500').all<any>()).results;
  return {
    indice: idx.map((r) => ({ month: r.month, assistant: labelOf(r.assistant), index: r.indice })),
    alertas: alerts.map((r) => ({ month: r.month, severity: SEVERITY_LABEL[r.severity], n: r.n })),
    achados: findings.map((f) => ({
      id: f.key, question: f.question_id, question_text: f.question_text, assistant: labelOf(f.assistant), code: f.category, claim: f.claim_id,
      severity: f.severity, finding: f.example, cause: f.cause, action: f.action, first_seen: f.first_seen, last_seen: f.last_seen,
      status: f.status === 'open' ? 'Aberto' : 'Resolvido',
    })),
    label: claims,
    perguntas: questions.map((q) => ({ ...q, claims: JSON.parse(q.claim_ids || '[]').join(', ') })),
    fontes: sources,
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/health') return json({ ok: true, servico: 'Observatório IA' });
    const html = (h: string, status = 200) => new Response(h, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    // Relatório partilhável: link sem login, que pode ser desativado a qualquer momento.
    let r: RegExpMatchArray | null;
    if ((r = path.match(/^\/r\/([a-f0-9]{32})$/)) && req.method === 'GET') {
      const rep = await env.DB.prepare('SELECT run_id, revoked FROM reports WHERE share_id = ?').bind(r[1]).first<{ run_id: string; revoked: number }>();
      if (!rep || rep.revoked) return html('<!doctype html><meta charset="utf-8"><title>Indisponível</title><p style="font-family:sans-serif;padding:40px">Este relatório não está disponível.</p>', 404);
      return html(renderReport(await buildReport(env, rep.run_id)));
    }
    if (path === '/manual' && req.method === 'GET') return html(MANUAL_HTML);
    if (!path.startsWith('/api/')) return json({ erro: 'Não encontrado' }, 404);

    const write = req.method !== 'GET';
    if (!authorized(req, env, write)) return json({ erro: 'Não autorizado' }, 401);

    try {
      const body = write ? await req.json<any>().catch(() => ({})) : {};
      let m: RegExpMatchArray | null;

      if (path === '/api/brands' && req.method === 'GET')
        return json((await env.DB.prepare('SELECT id, name, substance, holder, area, active FROM brands ORDER BY name').all()).results);
      if (path === '/api/brands' && req.method === 'POST') return json(await upsertBrand(env, body));

      if ((m = path.match(/^\/api\/brands\/([^/]+)\/extract-claims$/)) && req.method === 'POST')
        return json(await extractClaims(env, m[1], String(body.rcm_text ?? ''), String(body.rcm_version ?? thisMonth())));
      if ((m = path.match(/^\/api\/brands\/([^/]+)\/generate-questions$/)) && req.method === 'POST')
        return json(await generateQuestions(env, m[1], Number(body.n) || 60));
      if ((m = path.match(/^\/api\/brands\/([^/]+)\/pending$/)) && req.method === 'GET') {
        const claims = (await env.DB.prepare("SELECT * FROM claims WHERE brand_id = ? AND status = 'pending_review'").bind(m[1]).all()).results;
        const questions = (await env.DB.prepare("SELECT * FROM questions WHERE brand_id = ? AND status = 'pending_review'").bind(m[1]).all()).results;
        return json({ claims, questions });
      }
      if ((m = path.match(/^\/api\/brands\/([^/]+)\/approve$/)) && req.method === 'POST') {
        const st: D1PreparedStatement[] = [];
        for (const t of ['claims', 'questions'] as const) {
          const ids = body[t];
          if (ids === 'all') st.push(env.DB.prepare(`UPDATE ${t} SET status = 'approved' WHERE brand_id = ? AND status = 'pending_review'`).bind(m[1]));
          else if (Array.isArray(ids)) ids.forEach((id: string) => st.push(env.DB.prepare(`UPDATE ${t} SET status = 'approved' WHERE brand_id = ? AND id = ?`).bind(m![1], id)));
          const rej = body[`${t}_reject`];
          if (Array.isArray(rej)) rej.forEach((id: string) => st.push(env.DB.prepare(`UPDATE ${t} SET status = 'retired' WHERE brand_id = ? AND id = ?`).bind(m![1], id)));
        }
        if (st.length) await env.DB.batch(st);
        return json({ ok: true, alteracoes: st.length });
      }

      if (path === '/api/runs' && req.method === 'POST')
        return json(await startRun(env, String(body.brand_id), body.month, { question_ids: Array.isArray(body.question_ids) ? body.question_ids : undefined, reps: body.reps }));
      if (path === '/api/runs' && req.method === 'GET') {
        const b = url.searchParams.get('brand_id') ?? '';
        return json((await env.DB.prepare('SELECT id, month, status, started_at, finished_at FROM runs WHERE brand_id = ? ORDER BY started_at DESC LIMIT 24').bind(b).all()).results);
      }
      if ((m = path.match(/^\/api\/runs\/([^/]+)$/)) && req.method === 'GET') {
        const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(m[1]).first();
        const errors = (await env.DB.prepare('SELECT question_id, assistant, rep, error FROM responses WHERE run_id = ? AND error IS NOT NULL').bind(m[1]).all()).results;
        const index = (await env.DB.prepare("SELECT assistant, indice, responses FROM index_monthly WHERE run_id = ? AND persona = 'todas'").bind(m[1]).all()).results;
        const rep = await env.DB.prepare('SELECT share_id, revoked FROM reports WHERE run_id = ?').bind(m[1]).first<any>();
        const fv = await env.DB.prepare('SELECT COUNT(*) n, SUM(notified_at IS NOT NULL AND notified_at NOT LIKE \'a-enviar:%\') enviados FROM fv_alerts WHERE run_id = ?').bind(m[1]).first<any>();
        return json({
          run, indice: index, falhas: errors,
          relatorio: rep ? { link: `${(env.PUBLIC_URL || url.origin).replace(/\/$/, '')}/r/${rep.share_id}`, ativo: !rep.revoked } : null,
          farmacovigilancia: { sinais: fv?.n ?? 0, enviados: fv?.enviados ?? 0 },
        });
      }
      // Relatório: gerar (ou voltar a gerar) o link, ver os dados, desativar ou reativar o link.
      if ((m = path.match(/^\/api\/runs\/([^/]+)\/report$/))) {
        if (req.method === 'GET') return json(await buildReport(env, m[1]));
        if (req.method === 'POST') return json(await publishReport(env, m[1], body.email === true));
      }
      if ((m = path.match(/^\/api\/reports\/([a-f0-9]{32})$/)) && req.method === 'POST') {
        await env.DB.prepare("UPDATE reports SET revoked = ?, updated_at = datetime('now') WHERE share_id = ?").bind(body.ativo === true ? 0 : 1, m[1]).run();
        return json({ ok: true, ativo: body.ativo === true });
      }
      // Farmacovigilância: ver os sinais e reenviar os pendentes.
      if (path === '/api/fv' && req.method === 'GET') {
        const b = url.searchParams.get('brand_id');
        const q = b ? env.DB.prepare('SELECT * FROM fv_alerts WHERE brand_id = ? ORDER BY created_at DESC LIMIT 200').bind(b) : env.DB.prepare('SELECT * FROM fv_alerts ORDER BY created_at DESC LIMIT 200');
        return json((await q.all()).results);
      }
      if (path === '/api/fv/notify' && req.method === 'POST') return json(await notifyFv(env));
      if ((m = path.match(/^\/api\/runs\/([^/]+)\/rescore$/)) && req.method === 'POST') {
        const ids = (await env.DB.prepare('SELECT id FROM responses WHERE run_id = ? AND error IS NULL').bind(m[1]).all<{ id: string }>()).results;
        for (const r of ids) await refreshMetrics(env, r.id);
        await score(env, m[1]);
        return json({ ok: true, respostas_recalculadas: ids.length });
      }
      // Repete só o que falhou numa recolha (por exemplo, depois de carregar saldo): respostas com erro
      // e respostas a que falta a avaliação de um dos juízes. O que já correu bem não é repetido nem pago outra vez.
      if ((m = path.match(/^\/api\/runs\/([^/]+)\/retry$/)) && req.method === 'POST') {
        const runId = m[1];
        const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<any>();
        if (!run) return json({ erro: 'Recolha não existe' }, 404);
        const qs = (
          await env.DB.prepare(
            `SELECT DISTINCT r.question_id FROM responses r
             WHERE r.run_id = ? AND r.method = 'api' AND (
               r.error IS NOT NULL
               OR (SELECT COUNT(*) FROM judge_summaries j WHERE j.response_id = r.id) < 2
             )`,
          ).bind(runId).all<{ question_id: string }>()
        ).results.map((x) => x.question_id);
        if (!qs.length) return json({ ok: true, mensagem: 'Nada a repetir nesta recolha.' });
        const used = await env.DB.prepare("SELECT GROUP_CONCAT(DISTINCT assistant) a, MAX(rep) reps FROM responses WHERE run_id = ? AND method = 'api'").bind(runId).first<any>();
        const assistants = String(used?.a ?? '').split(',').filter(Boolean);
        const reps = Number(used?.reps) || 1;
        // O contador volta atrás para estas perguntas, para a recolha voltar a fechar quando terminarem.
        await env.DB.prepare("UPDATE runs SET status = 'running', finished_at = NULL, done_tasks = MAX(0, total_tasks - ?) WHERE id = ?").bind(qs.length, runId).run();
        const tag = Date.now().toString(36);
        await env.QUESTION_WORKFLOW.createBatch({
          instances: qs.map((q) => ({ id: `${runId}-${q}-r${tag}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100), params: { runId, brandId: run.brand_id, questionId: q, assistants, reps } })),
        } as any);
        return json({ ok: true, perguntas_a_repetir: qs.length, perguntas: qs });
      }
      // Volta a avaliar as respostas já recolhidas (por exemplo, depois de afinar a grelha dos juízes).
      // Não repete as chamadas aos assistentes. As decisões do revisor humano são mantidas.
      if ((m = path.match(/^\/api\/runs\/([^/]+)\/rejudge$/)) && req.method === 'POST') {
        const runId = m[1];
        const run = await env.DB.prepare('SELECT brand_id, month FROM runs WHERE id = ?').bind(runId).first<{ brand_id: string; month: string }>();
        if (!run) return json({ erro: 'Recolha não existe' }, 404);
        const resp = (await env.DB.prepare('SELECT id, question_id, assistant FROM responses WHERE run_id = ? AND error IS NULL').bind(runId).all<any>()).results;
        const st: D1PreparedStatement[] = [];
        for (const r of resp) {
          st.push(env.DB.prepare('DELETE FROM evaluations WHERE response_id = ?').bind(r.id));
          st.push(env.DB.prepare('DELETE FROM judge_summaries WHERE response_id = ?').bind(r.id));
          st.push(env.DB.prepare('DELETE FROM sentences WHERE response_id = ? AND reviewed_by IS NULL').bind(r.id));
          // Achados que só existem por causa desta recolha voltam a ser calculados.
          st.push(
            env.DB.prepare('DELETE FROM findings WHERE brand_id = ? AND question_id = ? AND assistant = ? AND first_seen = ? AND last_seen = ?')
              .bind(run.brand_id, r.question_id, r.assistant, run.month, run.month),
          );
        }
        if (st.length) await env.DB.batch(st);
        for (const r of resp) await env.EVAL_WORKFLOW.create({ params: { runId, responseId: r.id } });
        return json({ ok: true, respostas_em_reavaliacao: resp.length });
      }

      // Recolha manual para os assistentes sem API
      if (path === '/api/manual-tasks' && req.method === 'GET') {
        const runId = url.searchParams.get('run_id') ?? '';
        const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<any>();
        if (!run) return json({ erro: 'Recolha não existe' }, 404);
        const qs = (await env.DB.prepare("SELECT id, text FROM questions WHERE brand_id = ? AND status = 'approved' ORDER BY id").bind(run.brand_id).all<any>()).results;
        const done = new Set((await env.DB.prepare("SELECT question_id || '|' || assistant || '|' || rep k FROM responses WHERE run_id = ? AND method = 'manual'").bind(runId).all<any>()).results.map((r) => r.k));
        const tasks = [];
        for (const a of list(env.ASSISTENTES_MANUAIS)) for (const q of qs) if (!done.has(`${q.id}|${a}|1`)) tasks.push({ question_id: q.id, assistant: a, rep: 1, pergunta: q.text });
        return json({ run_id: runId, protocolo: 'Sessão nova, sem conta pessoal, localização em Portugal. Copiar a resposta completa e as fontes citadas.', tarefas: tasks });
      }
      if (path === '/api/manual-response' && req.method === 'POST') {
        if (!list(env.ASSISTENTES_MANUAIS).includes(body.assistant)) return json({ erro: `Assistente inválido. Usar: ${env.ASSISTENTES_MANUAIS}` }, 400);
        const responseId = await storeManual(env, body);
        await env.EVAL_WORKFLOW.create({ params: { runId: body.run_id, responseId } });
        return json({ ok: true, response_id: responseId, estado: 'em avaliação' });
      }

      // Revisão humana (gravidade 3 e 4, e desacordo entre juízes)
      if (path === '/api/review' && req.method === 'GET') {
        const brandId = url.searchParams.get('brand_id') ?? '';
        const rows = (
          await env.DB.prepare(
            `SELECT s.response_id, s.idx, s.sentence, s.claim_id, s.status, s.category, s.severity, s.agreed, r.assistant, r.question_id, q.text AS pergunta
             FROM sentences s JOIN responses r ON r.id = s.response_id JOIN questions q ON q.brand_id = r.brand_id AND q.id = r.question_id
             WHERE r.brand_id = ? AND s.needs_review = 1 ORDER BY s.severity DESC LIMIT 200`,
          ).bind(brandId).all()
        ).results;
        return json(rows);
      }
      if (path === '/api/review' && req.method === 'POST') {
        await env.DB.prepare(
          `UPDATE sentences SET status = ?, category = ?, severity = ?, claim_id = COALESCE(?, claim_id), needs_review = 0, agreed = 1, reviewed_by = ?, reviewed_at = datetime('now')
           WHERE response_id = ? AND idx = ?`,
        ).bind(body.status, body.category ?? null, Number(body.severity) || 0, body.claim_id ?? null, body.reviewer ?? 'revisor', body.response_id, Number(body.idx)).run();
        // A decisão do revisor entra logo no índice da recolha.
        const r = await env.DB.prepare('SELECT run_id FROM responses WHERE id = ?').bind(body.response_id).first<{ run_id: string }>();
        await refreshMetrics(env, body.response_id);
        if (r) await score(env, r.run_id);
        return json({ ok: true });
      }

      if ((m = path.match(/^\/api\/export\/([^/]+)$/)) && req.method === 'GET') return json(await exportBrand(env, m[1]));

      return json({ erro: 'Não encontrado' }, 404);
    } catch (e) {
      return json({ erro: String(e instanceof Error ? e.message : e) }, 500);
    }
  },

  // Dia 1 de cada mês: arranca a recolha de todas as marcas ativas.
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    const brands = (await env.DB.prepare('SELECT id FROM brands WHERE active = 1').all<{ id: string }>()).results;
    ctx.waitUntil(Promise.all(brands.map((b) => startRun(env, b.id).catch((e) => console.error(`Recolha ${b.id} falhou:`, e)))));
  },
} satisfies ExportedHandler<Env>;
