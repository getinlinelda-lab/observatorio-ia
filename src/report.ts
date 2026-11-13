// Relatório automático de cada recolha: dados, página de uma página com link partilhável e aviso por email.

import type { Citation, Env } from './env';
import { ASSISTANT_LABELS } from './assistants';
import { SEVERITY_LABEL } from './judge';
import { domainType } from './pipeline';
import { esc, sendEmail } from './notify';

const J = <T>(s: string | null | undefined, d: T): T => {
  try { return s ? (JSON.parse(s) as T) : d; } catch { return d; }
};
const label = (a: string) => (a === 'global' ? 'Global' : ASSISTANT_LABELS[a] ?? a);
const CAT: Record<string, string> = {
  'OL-I': 'Indicação fora do label', 'OL-P': 'População fora do label', 'OL-D': 'Dose ou intervalo fora do label', CMP: 'Comparação não suportada',
  SEG: 'Segurança', OMI: 'Omissão', ACE: 'Acesso em Portugal', FV: 'Farmacovigilância',
};

export async function buildReport(env: Env, runId: string) {
  const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<any>();
  if (!run) throw new Error('Recolha não existe');
  const b = await env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(run.brand_id).first<any>();
  const official = J<string[]>(b?.official_domains, []);
  const idx = (await env.DB.prepare("SELECT * FROM index_monthly WHERE run_id = ? AND persona = 'todas'").bind(runId).all<any>()).results;
  const personas = (await env.DB.prepare("SELECT persona, indice, responses FROM index_monthly WHERE run_id = ? AND assistant = 'global' AND persona <> 'todas' ORDER BY indice").bind(runId).all<any>()).results;
  const prev = await env.DB.prepare(
    `SELECT i.indice, r.month FROM index_monthly i JOIN runs r ON r.id = i.run_id
     WHERE r.brand_id = ? AND r.month < ? AND r.status = 'complete' AND r.id NOT LIKE '%-teste-%' AND i.assistant = 'global' AND i.persona = 'todas'
     ORDER BY r.month DESC, r.started_at DESC LIMIT 1`,
  ).bind(run.brand_id, run.month).first<any>();
  const sev = (
    await env.DB.prepare(
      `SELECT s.severity, COUNT(*) n FROM sentences s JOIN responses r ON r.id = s.response_id WHERE r.run_id = ? AND s.severity > 0 GROUP BY s.severity`,
    ).bind(runId).all<any>()
  ).results;
  const top = (
    await env.DB.prepare(
      `SELECT s.sentence, s.category, s.severity, s.needs_review, r.assistant, r.question_id, q.text AS pergunta, q.persona
       FROM sentences s JOIN responses r ON r.id = s.response_id JOIN questions q ON q.brand_id = r.brand_id AND q.id = r.question_id
       WHERE r.run_id = ? AND s.severity >= 3 ORDER BY s.severity DESC, r.question_id LIMIT 8`,
    ).bind(runId).all<any>()
  ).results;
  const resp = (await env.DB.prepare('SELECT assistant, citations FROM responses WHERE run_id = ? AND error IS NULL').bind(runId).all<any>()).results;
  const types = new Map<string, number>();
  const domains = new Map<string, number>();
  let total = 0;
  resp.forEach((r) =>
    J<Citation[]>(r.citations, []).forEach((c) => {
      total++;
      const t = domainType(c.domain, official);
      types.set(t, (types.get(t) ?? 0) + 1);
      domains.set(c.domain, (domains.get(c.domain) ?? 0) + 1);
    }),
  );
  const fv = await env.DB.prepare('SELECT COUNT(*) n FROM fv_alerts WHERE run_id = ?').bind(runId).first<{ n: number }>();
  const g = idx.find((i) => i.assistant === 'global');
  return {
    run_id: runId,
    teste: runId.includes('-teste-'),
    marca: b?.name ?? run.brand_id,
    substancia: b?.substance ?? '',
    mes: run.month,
    concluida: run.finished_at,
    respostas: g?.responses ?? 0,
    indice_global: g?.indice ?? null,
    // Uma recolha de teste usa poucas perguntas: compará-la com um mês completo induziria em erro.
    indice_anterior: prev && !runId.includes('-teste-') ? { mes: prev.month, indice: prev.indice } : null,
    componentes: g ? { exatidao: g.exatidao, seguranca: g.seguranca, conformidade: g.conformidade, completude: g.completude, autoridade: g.autoridade, consistencia: g.consistencia } : null,
    por_assistente: idx.filter((i) => i.assistant !== 'global').map((i) => ({ assistente: label(i.assistant), indice: i.indice, respostas: i.responses })).sort((a, z) => (z.indice ?? 0) - (a.indice ?? 0)),
    por_perfil: personas.map((p) => ({ perfil: p.persona, indice: p.indice, respostas: p.responses })),
    sinais: [1, 2, 3, 4].map((s) => ({ gravidade: s, nivel: SEVERITY_LABEL[s], n: sev.find((x) => x.severity === s)?.n ?? 0 })),
    mais_graves: top.map((t) => ({
      assistente: label(t.assistant), pergunta_id: t.question_id, pergunta: t.pergunta, perfil: t.persona,
      categoria: CAT[t.category] ?? t.category ?? '', gravidade: t.severity, nivel: SEVERITY_LABEL[t.severity], frase: t.sentence, por_validar: !!t.needs_review,
    })),
    fontes: {
      total,
      por_tipo: [...types].map(([tipo, n]) => ({ tipo, n, pct: total ? Math.round((n / total) * 1000) / 10 : 0 })).sort((a, z) => z.n - a.n),
      dominios: [...domains].sort((a, z) => z[1] - a[1]).slice(0, 8).map(([dominio, n]) => ({ dominio, n })),
    },
    farmacovigilancia: fv?.n ?? 0,
  };
}

type Report = Awaited<ReturnType<typeof buildReport>>;
const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '–' : n.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${Math.round(n * 100)}%`);

export function renderReport(r: Report): string {
  const delta = r.indice_anterior && r.indice_global !== null ? r.indice_global - r.indice_anterior.indice : null;
  const comp: [string, number | null | undefined][] = r.componentes
    ? [['Exatidão', r.componentes.exatidao], ['Segurança', r.componentes.seguranca], ['Conformidade com o label', r.componentes.conformidade], ['Completude', r.componentes.completude], ['Autoridade das fontes', r.componentes.autoridade], ['Consistência', r.componentes.consistencia]]
    : [];
  const graves = r.sinais.filter((s) => s.gravidade >= 3).reduce((a, s) => a + s.n, 0);
  return `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(r.marca)} na IA · ${esc(r.mes)}</title>
<style>
:root{--bg:#fff;--alt:#f5f5f7;--t:#1d1d1f;--t2:#6e6e73;--h:#d2d2d7;--b:#0071e3;--r:#ff3b30;--o:#ff9f0a;--g:#34c759}
@media (prefers-color-scheme:dark){:root{--bg:#000;--alt:#1c1c1e;--t:#f5f5f7;--t2:#a1a1a6;--h:#38383a;--b:#2997ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.47 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;letter-spacing:-.01em}
main{max-width:960px;margin:0 auto;padding:40px 20px 56px}h1,h2,h3,p{margin:0}h1{font-size:clamp(32px,5vw,48px);letter-spacing:-.03em;line-height:1.08}
h2{font-size:22px;letter-spacing:-.02em;margin:40px 0 14px}.k{color:var(--t2);font-size:14px}.lead{color:var(--t2);font-size:18px;margin-top:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}.card{background:var(--alt);border-radius:18px;padding:20px}
.big{font-size:48px;font-weight:700;letter-spacing:-.04em;line-height:1.05;font-variant-numeric:tabular-nums}.d{font-size:14px;margin-top:4px}
.up{color:var(--g)}.down{color:var(--r)}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--h);vertical-align:top;font-size:15px}th{color:var(--t2);font-weight:500;font-size:13px}
.bar{height:8px;border-radius:4px;background:var(--h);overflow:hidden;min-width:80px}.bar i{display:block;height:100%;background:var(--b)}
.pill{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:var(--alt);color:var(--t2)}.c4{background:var(--r);color:#fff}.c3{background:var(--o);color:#fff}
.f{border:1px solid var(--h);border-radius:14px;padding:14px 16px;margin-bottom:10px}.f p+p{margin-top:6px}.q{color:var(--t2);font-size:14px}
.warn{background:#fff4e5;color:#7a4b00;border-radius:12px;padding:12px 14px;font-size:14px;margin-top:16px}
@media (prefers-color-scheme:dark){.warn{background:#3a2a10;color:#ffd79a}}
footer{color:var(--t2);font-size:12px;margin-top:40px;border-top:1px solid var(--h);padding-top:14px}
@media print{main{padding:0}.card{break-inside:avoid}}
</style></head><body><main>
<p class="k">Observatório IA · relatório da recolha de ${esc(r.mes)}${r.teste ? ' · <b>recolha de teste</b>' : ''}</p>
<h1>${esc(r.marca)} nas respostas da IA</h1>
<p class="lead">${esc(r.respostas)} respostas de ${esc(r.por_assistente.length)} assistentes de IA, avaliadas frase a frase contra o RCM aprovado.</p>
${r.farmacovigilancia ? `<p class="warn"><b>Farmacovigilância:</b> ${r.farmacovigilancia} sinal(is) registado(s) no protocolo de farmacovigilância e enviado(s) à equipa de Farmacovigilância do titular, que faz a avaliação.</p>` : ''}
<h2>Resumo</h2><div class="grid">
<div class="card"><p class="k">Índice da marca</p><p class="big">${fmt(r.indice_global)}</p><p class="d ${delta === null ? '' : delta >= 0 ? 'up' : 'down'}">${delta === null ? (r.teste ? 'Teste: sem comparação mensal' : 'Primeira medição') : `${delta >= 0 ? '+' : ''}${fmt(delta)} face a ${esc(r.indice_anterior!.mes)}`}</p></div>
<div class="card"><p class="k">Sinais de risco alto e crítico</p><p class="big">${graves}</p><p class="d k">${r.sinais.map((s) => `${esc(s.nivel)} ${s.n}`).join(' · ')}</p></div>
<div class="card"><p class="k">Citações de fontes oficiais PT/UE</p><p class="big">${fmt(r.fontes.por_tipo.find((t) => t.tipo === 'Oficial PT/UE')?.pct ?? 0)}%</p><p class="d k">${r.fontes.total} citações no total</p></div>
</div>
<h2>Por assistente</h2><table><tr><th>Assistente</th><th>Índice</th><th></th><th>Respostas</th></tr>
${r.por_assistente.map((a) => `<tr><td>${esc(a.assistente)}</td><td>${fmt(a.indice)}</td><td style="width:40%"><div class="bar"><i style="width:${Math.max(0, Math.min(100, a.indice ?? 0))}%"></i></div></td><td>${a.respostas}</td></tr>`).join('')}</table>
${comp.length ? `<h2>Componentes do índice</h2><table>${comp.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `<tr><td>${k}</td><td>${pct(v)}</td><td style="width:50%"><div class="bar"><i style="width:${Math.round((v ?? 0) * 100)}%"></i></div></td></tr>`).join('')}</table>
${comp.some(([, v]) => v === null || v === undefined) ? `<p class="k" style="margin-top:10px">Sem dados nesta recolha: ${comp.filter(([, v]) => v === null || v === undefined).map(([k]) => (k === 'Consistência' ? 'consistência (exige duas ou mais repetições por pergunta)' : k.toLowerCase())).join(', ')}.</p>` : ''}` : ''}
${r.por_perfil.length ? `<h2>Por perfil de quem pergunta</h2><table><tr><th>Perfil</th><th>Índice</th><th>Respostas</th></tr>${r.por_perfil.map((p) => `<tr><td>${esc(p.perfil)}</td><td>${fmt(p.indice)}</td><td>${p.respostas}</td></tr>`).join('')}</table>` : ''}
<h2>Sinais mais graves</h2>
${r.mais_graves.length ? r.mais_graves.map((f) => `<div class="f"><p><span class="pill c${f.gravidade}">${esc(f.nivel)}</span> <span class="pill">${esc(f.categoria)}</span> <span class="pill">${esc(f.assistente)}</span>${f.por_validar ? ' <span class="pill">em validação científica</span>' : ''}</p>
<p class="q">${esc(f.pergunta_id)} · ${esc(f.perfil)}: ${esc(f.pergunta)}</p><p>«${esc(f.frase)}»</p></div>`).join('') : '<p class="k">Sem sinais de risco alto ou crítico nesta recolha.</p>'}
<h2>De onde vem a informação</h2><table><tr><th>Tipo de fonte</th><th>Citações</th><th>%</th></tr>
${r.fontes.por_tipo.map((t) => `<tr><td>${esc(t.tipo)}</td><td>${t.n}</td><td>${fmt(t.pct)}%</td></tr>`).join('')}</table>
${r.fontes.dominios.length ? `<p class="k" style="margin-top:10px">Mais citados: ${r.fontes.dominios.map((d) => `${esc(d.dominio)} (${d.n})`).join(' · ')}</p>` : ''}
<footer><p>Sinais gerados por um processo automático com dois avaliadores independentes; os de risco alto e crítico estão sujeitos a validação científica. Não constitui avaliação regulamentar nem aconselhamento médico. Respostas obtidas por API, que podem diferir das versões públicas das aplicações.</p>
<p style="margin-top:6px">Recolha ${esc(r.run_id)} · concluída ${esc(r.concluida ?? '')} UTC · documento confidencial, para uso interno do titular.</p></footer>
</main></body></html>`;
}

const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');

// Cria (ou reaproveita) o link do relatório da recolha e avisa por email. Chamado quando a recolha fecha.
export async function publishReport(env: Env, runId: string, notify = true) {
  const run = await env.DB.prepare('SELECT brand_id, month FROM runs WHERE id = ?').bind(runId).first<any>();
  if (!run) throw new Error('Recolha não existe');
  let rep = await env.DB.prepare('SELECT share_id FROM reports WHERE run_id = ?').bind(runId).first<{ share_id: string }>();
  if (!rep) {
    const id = newId();
    await env.DB.prepare('INSERT INTO reports (share_id, run_id, brand_id) VALUES (?, ?, ?)').bind(id, runId, run.brand_id).run();
    rep = { share_id: id };
  } else {
    await env.DB.prepare("UPDATE reports SET updated_at = datetime('now') WHERE share_id = ?").bind(rep.share_id).run();
  }
  const link = `${(env.PUBLIC_URL || '').replace(/\/$/, '')}/r/${rep.share_id}`;
  let email = 'não pedido';
  if (notify && !env.RESEND_API_KEY) email = 'não enviado: falta o segredo RESEND_API_KEY';
  else if (notify && !env.ALERT_EMAIL) email = 'não enviado: falta ALERT_EMAIL';
  else if (notify) {
    const data = await buildReport(env, runId);
    await sendEmail(
      env,
      env.ALERT_EMAIL!,
      `Relatório pronto: ${data.marca}, ${data.mes}${data.teste ? ' (teste)' : ''}`,
      `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d1d1f"><p>A recolha <b>${esc(runId)}</b> terminou.</p>
<p>Índice global: <b>${fmt(data.indice_global)}</b> · ${data.respostas} respostas · ${data.sinais.filter((s) => s.gravidade >= 3).reduce((a, s) => a + s.n, 0)} sinais de risco alto ou crítico${data.farmacovigilancia ? ` · ${data.farmacovigilancia} alerta(s) de farmacovigilância` : ''}.</p>
<p><a href="${esc(link)}">Abrir o relatório</a></p><p style="color:#6e6e73;font-size:13px">O link pode ser partilhado e desativado a qualquer momento.</p></div>`,
    ).then(() => { email = `enviado para ${env.ALERT_EMAIL}`; }).catch((e) => { email = `falhou: ${String(e instanceof Error ? e.message : e)}`; console.error('Email do relatório falhou:', e); });
  }
  return { share_id: rep.share_id, link, email };
}
