// Chamadas de texto simples aos modelos usados como juízes e para extrair o label.

import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from './env';

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) {
    const msg = `${url} respondeu ${res.status}: ${txt.slice(0, 500)}`;
    // Erros 4xx (exceto 429) e falta de saldo não melhoram com nova tentativa.
    if ((res.status >= 400 && res.status < 500 && res.status !== 429) || /insufficient_quota|credit_balance/.test(txt)) throw new NonRetryableError(msg);
    throw new Error(msg);
  }
  return JSON.parse(txt);
}

export async function askClaude(env: Env, model: string, system: string, user: string, maxTokens = 8000): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new NonRetryableError('Falta o segredo ANTHROPIC_API_KEY');
  const raw = await post(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
  );
  return (raw.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
}

export async function askOpenAI(env: Env, model: string, system: string, user: string): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new NonRetryableError('Falta o segredo OPENAI_API_KEY');
  const raw = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${env.OPENAI_API_KEY}` }, { model, instructions: system, input: user });
  const out: string[] = [];
  for (const item of raw.output ?? []) if (item.type === 'message') for (const c of item.content ?? []) if (typeof c.text === 'string') out.push(c.text);
  return out.join('');
}

// Extrai o primeiro objeto JSON de uma resposta (tolera texto ou ```json à volta).
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('A resposta do modelo não trouxe JSON: ' + text.slice(0, 300));
  return JSON.parse(body.slice(start, end + 1)) as T;
}
