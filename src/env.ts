export interface Env {
  DB: D1Database;
  PROVAS: R2Bucket;
  QUESTION_WORKFLOW: Workflow<QuestionParams>;
  EVAL_WORKFLOW: Workflow<EvalParams>;

  // Segredos (npx wrangler secret put NOME)
  API_TOKEN: string;
  READ_TOKEN?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string; // envio de emails (alertas e relatórios)

  // Variáveis (wrangler.jsonc)
  REPETICOES: string;
  ASSISTENTES_API: string;
  ASSISTENTES_MANUAIS: string;
  OPENAI_MODEL: string;
  GEMINI_MODEL: string;
  PERPLEXITY_MODEL: string;
  CLAUDE_MODEL: string;
  JUIZ_CLAUDE_MODEL: string;
  JUIZ_OPENAI_MODEL: string;
  ALERT_EMAIL?: string; // destinatário por omissão dos alertas e relatórios
  EMAIL_FROM?: string; // remetente; sem domínio verificado usar onboarding@resend.dev
  PUBLIC_URL?: string; // endereço público do Worker, para os links dos relatórios
  MODO_TESTE?: string; // '1' = respostas e avaliações simuladas, sem chamadas às APIs
}

export interface QuestionParams {
  runId: string;
  brandId: string;
  questionId: string;
  assistants: string[];
  reps: number;
}

export interface EvalParams {
  runId: string;
  responseId: string;
}

export interface Citation {
  url: string;
  title?: string;
  domain: string;
}

export interface Collected {
  model: string;
  text: string;
  citations: Citation[];
  raw: unknown;
}

export const list = (s: string | undefined): string[] =>
  (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
