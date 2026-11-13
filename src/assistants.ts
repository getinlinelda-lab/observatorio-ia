// Módulo 4 — Recolha. Um adaptador por assistente com API.
// Protocolo fixo: pedido novo e sem histórico, localização em Lisboa, pergunta tal como uma pessoa a escreveria.
// Copilot, Google AI Overviews e Meta AI não têm API equivalente à versão pública: são recolhidos
// manualmente (ver /api/manual-tasks e /api/manual-response no README).

import { NonRetryableError } from 'cloudflare:workflows';
import type { Citation, Collected, Env } from './env';

const LOCAL = { city: 'Lisboa', region: 'Lisboa', country: 'PT', timezone: 'Europe/Lisbon' };

export const domainOf = (url: string, title?: string): string => {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    // O Gemini devolve links de redirecionamento; nesse caso o título traz o domínio real.
    if (h.includes('vertexaisearch') || h.includes('googleusercontent')) return (title ?? h).toLowerCase();
    return h.toLowerCase();
  } catch {
    return (title ?? url).toLowerCase();
  }
};

const cite = (url: string, title?: string): Citation => ({ url, title, domain: domainOf(url, title) });

const dedupe = (cs: Citation[]): Citation[] => {
  const seen = new Set<string>();
  return cs.filter((c) => (c.url && !seen.has(c.url) ? (seen.add(c.url), true) : false));
};

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) {
    const msg = `${url} respondeu ${res.status}: ${txt.slice(0, 500)}`;
    // Erros 4xx (exceto 429) e falta de saldo não melhoram com nova tentativa.
    if ((res.status >= 400 && res.status < 500 && res.status !== 429) || /insufficient_quota|credit_balance/.test(txt)) throw new NonRetryableError(msg);
    throw new Error(msg);
  }
  return JSON.parse(txt);
}

// ChatGPT — OpenAI Responses API com a ferramenta web_search
async function chatgpt(env: Env, question: string): Promise<Collected> {
  if (!env.OPENAI_API_KEY) throw new NonRetryableError('Falta o segredo OPENAI_API_KEY');
  const raw = await postJson(
    'https://api.openai.com/v1/responses',
    { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    {
      model: env.OPENAI_MODEL,
      input: question,
      tools: [{ type: 'web_search', user_location: { type: 'approximate', ...LOCAL } }],
      include: ['web_search_call.action.sources'],
      tool_choice: 'auto',
    },
  );
  const texts: string[] = [];
  const cites: Citation[] = [];
  for (const item of raw.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (typeof c.text === 'string') texts.push(c.text);
        for (const a of c.annotations ?? []) if (a.type === 'url_citation' && a.url) cites.push(cite(a.url, a.title));
      }
    }
    if (item.type === 'web_search_call') {
      for (const s of item.action?.sources ?? []) if (s?.url) cites.push(cite(s.url, s.title));
    }
  }
  return { model: raw.model ?? env.OPENAI_MODEL, text: texts.join('\n'), citations: dedupe(cites), raw };
}

// Gemini — generateContent com a ferramenta google_search
async function gemini(env: Env, question: string): Promise<Collected> {
  if (!env.GEMINI_API_KEY) throw new NonRetryableError('Falta o segredo GEMINI_API_KEY');
  const raw = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    { 'x-goog-api-key': env.GEMINI_API_KEY },
    { contents: [{ role: 'user', parts: [{ text: question }] }], tools: [{ google_search: {} }] },
  );
  const cand = raw.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const cites: Citation[] = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((g: any) => g.web)
    .filter((w: any) => w?.uri)
    .map((w: any) => cite(w.uri, w.title));
  return { model: raw.modelVersion ?? env.GEMINI_MODEL, text, citations: dedupe(cites), raw };
}

// Perplexity — Agent API com web_search (a Sonar Chat Completions deixou de ser suportada em set. 2026)
async function perplexity(env: Env, question: string): Promise<Collected> {
  if (!env.PERPLEXITY_API_KEY) throw new NonRetryableError('Falta o segredo PERPLEXITY_API_KEY');
  const body: Record<string, unknown> = {
    input: question,
    tools: [{ type: 'web_search', user_location: { country: LOCAL.country, region: LOCAL.region, city: LOCAL.city } }],
  };
  if (env.PERPLEXITY_MODEL) body.model = env.PERPLEXITY_MODEL;
  const raw = await postJson('https://api.perplexity.ai/v1/agent', { authorization: `Bearer ${env.PERPLEXITY_API_KEY}` }, body);
  const texts: string[] = [];
  const cites: Citation[] = [];
  for (const item of raw.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && typeof c.text === 'string') texts.push(c.text);
        for (const a of c.annotations ?? []) if (a.url) cites.push(cite(a.url, a.title));
      }
    }
    if (item.type === 'search_results') for (const r of item.results ?? []) if (r.url) cites.push(cite(r.url, r.title));
  }
  return { model: raw.model ?? 'perplexity', text: texts.join('\n'), citations: dedupe(cites), raw };
}

// Claude — Messages API com a ferramenta web_search (versão base, chamada direta)
async function claude(env: Env, question: string): Promise<Collected> {
  if (!env.ANTHROPIC_API_KEY) throw new NonRetryableError('Falta o segredo ANTHROPIC_API_KEY');
  const messages: any[] = [{ role: 'user', content: question }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', ...LOCAL } }];
  const pages: any[] = [];
  let content: any[] = [];
  for (let i = 0; i < 4; i++) {
    const raw = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: env.CLAUDE_MODEL, max_tokens: 4096, messages, tools },
    );
    pages.push(raw);
    content = content.concat(raw.content ?? []);
    if (raw.stop_reason !== 'pause_turn') break;
    // Pausa longa da pesquisa: devolver a mensagem tal como veio para continuar.
    messages.push({ role: 'assistant', content: raw.content });
  }
  const texts: string[] = [];
  const cites: Citation[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      texts.push(b.text);
      for (const c of b.citations ?? []) if (c.url) cites.push(cite(c.url, c.title));
    }
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) cites.push(cite(r.url, r.title));
    }
  }
  return { model: pages.at(-1)?.model ?? env.CLAUDE_MODEL, text: texts.join(''), citations: dedupe(cites), raw: pages };
}

export const ADAPTERS: Record<string, (env: Env, q: string) => Promise<Collected>> = {
  chatgpt,
  gemini,
  perplexity,
  claude,
};

export const ASSISTANT_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  claude: 'Claude',
  copilot: 'Copilot',
  ai_overviews: 'Google AI Overviews',
  meta_ai: 'Meta AI',
};
