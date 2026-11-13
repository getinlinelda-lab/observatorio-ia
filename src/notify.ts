// Envio de emails (Resend) e protocolo de farmacovigilância.
// Sem RESEND_API_KEY os alertas ficam registados e pendentes; nada se perde.

import type { Env } from './env';
import { ASSISTANT_LABELS } from './assistants';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('Falta o segredo RESEND_API_KEY');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM || 'Observatório IA <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function recipient(env: Env, brandId: string): Promise<string | null> {
  const b = await env.DB.prepare('SELECT alert_email FROM brands WHERE id = ?').bind(brandId).first<{ alert_email: string | null }>();
  return b?.alert_email || env.ALERT_EMAIL || null;
}

// Regista os sinais de farmacovigilância de uma resposta (chamado depois de juntar os juízes).
export async function flagFv(env: Env, responseId: string) {
  const rows = (
    await env.DB.prepare(
      `SELECT s.idx, s.sentence, s.category, s.severity, r.run_id, r.brand_id, r.question_id, r.assistant
       FROM sentences s JOIN responses r ON r.id = s.response_id
       WHERE s.response_id = ? AND (s.category = 'FV' OR s.severity >= 4)`,
    ).bind(responseId).all<any>()
  ).results;
  if (!rows.length) return 0;
  await env.DB.batch(
    rows.map((s) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO fv_alerts (id, run_id, brand_id, question_id, assistant, response_id, idx, sentence, category, severity, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`${responseId}:${s.idx}`, s.run_id, s.brand_id, s.question_id, s.assistant, responseId, s.idx, s.sentence, s.category, s.severity,
        s.category === 'FV' ? 'evento_adverso' : 'desvio_risco'),
    ),
  );
  return rows.length;
}

// Envia os alertas pendentes, agrupados por marca, num único email por marca.
// Os alertas são reservados antes do envio, para duas perguntas a terminar ao mesmo tempo não enviarem o mesmo alerta duas vezes.
export async function notifyFv(env: Env): Promise<{ enviados: number; pendentes: number }> {
  if (!env.RESEND_API_KEY) {
    const left = await env.DB.prepare('SELECT COUNT(*) n FROM fv_alerts WHERE notified_at IS NULL').first<{ n: number }>();
    return { enviados: 0, pendentes: left?.n ?? 0 };
  }
  const claim = `a-enviar:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `UPDATE fv_alerts SET notified_at = ? WHERE id IN (SELECT id FROM fv_alerts WHERE notified_at IS NULL OR (notified_at LIKE 'a-enviar:%' AND created_at < datetime('now', '-15 minutes')) LIMIT 200)`,
  ).bind(claim).run();
  const pend = (
    await env.DB.prepare(
      `SELECT a.*, q.text AS pergunta, b.name AS marca FROM fv_alerts a
       JOIN questions q ON q.brand_id = a.brand_id AND q.id = a.question_id JOIN brands b ON b.id = a.brand_id
       WHERE a.notified_at = ? ORDER BY a.brand_id, a.severity DESC`,
    ).bind(claim).all<any>()
  ).results;
  let sent = 0;
  const byBrand = new Map<string, any[]>();
  pend.forEach((a) => byBrand.set(a.brand_id, [...(byBrand.get(a.brand_id) ?? []), a]));
  for (const [brandId, items] of byBrand) {
    const ids = items.map((a) => a.id);
    const setAll = (sql: string, ...vals: unknown[]) => env.DB.batch(ids.map((id) => env.DB.prepare(sql).bind(...vals, id)));
    const to = await recipient(env, brandId);
    if (!to) { await setAll('UPDATE fv_alerts SET notified_at = NULL, notify_error = ? WHERE id = ?', 'Sem destinatário: definir ALERT_EMAIL ou o contacto da marca'); continue; }
    const marca = items[0].marca;
    const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d1d1f;max-width:640px">
<h2 style="margin:0 0 8px">Farmacovigilância: ${items.length} sinal(is) em respostas de IA sobre ${esc(marca)}</h2>
<p style="color:#6e6e73;margin:0 0 16px">Protocolo do Observatório IA. A avaliação e a eventual notificação às autoridades ficam com a equipa de Farmacovigilância do titular, segundo os seus procedimentos. O Observatório não avalia nem notifica.</p>
${items.map((a) => `<div style="border:1px solid #d2d2d7;border-radius:12px;padding:14px 16px;margin:0 0 12px">
<p style="margin:0 0 6px;font-size:13px;color:#6e6e73">${esc(ASSISTANT_LABELS[a.assistant] ?? a.assistant)} · ${a.reason === 'evento_adverso' ? 'Possível evento adverso' : 'Contradição com o RCM que pode levar a dano'} · gravidade ${a.severity} · ${esc(a.created_at)} UTC</p>
<p style="margin:0 0 6px"><b>Pergunta (${esc(a.question_id)}):</b> ${esc(a.pergunta)}</p>
<p style="margin:0"><b>Frase da IA:</b> «${esc(a.sentence)}»</p>
<p style="margin:6px 0 0;font-size:12px;color:#6e6e73">Prova completa guardada: recolha ${esc(a.run_id)}, resposta ${esc(a.response_id)}</p></div>`).join('')}
</div>`;
    try {
      await sendEmail(env, to, `[Farmacovigilância] ${items.length} sinal(is) IA, ${marca}`, html);
      await setAll('UPDATE fv_alerts SET notified_at = ?, notified_to = ?, notify_error = NULL WHERE id = ?', new Date().toISOString(), to);
      sent += items.length;
    } catch (e) {
      await setAll('UPDATE fv_alerts SET notified_at = NULL, notify_error = ? WHERE id = ?', String(e).slice(0, 500));
    }
  }
  const left = await env.DB.prepare('SELECT COUNT(*) n FROM fv_alerts WHERE notified_at IS NULL').first<{ n: number }>();
  return { enviados: sent, pendentes: left?.n ?? 0 };
}
