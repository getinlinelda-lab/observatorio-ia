import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { Env, EvalParams, QuestionParams } from './env';
import { collect, completeIfDone, judge, markDone, merge, recordFailure, score } from './pipeline';
import { flagFv, notifyFv } from './notify';

const RETRY: WorkflowStepConfig = { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' };

async function monthOf(env: Env, runId: string): Promise<string> {
  const r = await env.DB.prepare('SELECT month FROM runs WHERE id = ?').bind(runId).first<{ month: string }>();
  return r?.month ?? new Date().toISOString().slice(0, 7);
}

// Uma instância por pergunta: recolhe em cada assistente com API (com repetições), avalia e junta.
export class QuestionWorkflow extends WorkflowEntrypoint<Env, QuestionParams> {
  async run(event: WorkflowEvent<QuestionParams>, step: WorkflowStep) {
    const { runId, brandId, questionId, assistants, reps } = event.payload;
    const month = await step.do('mês da recolha', () => monthOf(this.env, runId));

    const ids: string[] = [];
    for (const a of assistants) {
      for (let rep = 1; rep <= reps; rep++) {
        try {
          ids.push(await step.do(`recolher ${a} #${rep}`, RETRY, () => collect(this.env, runId, brandId, questionId, a, rep)));
        } catch (e) {
          await step.do(`registar falha ${a} #${rep}`, () => recordFailure(this.env, runId, brandId, questionId, a, rep, String(e)));
        }
      }
    }

    for (const id of ids) {
      for (const who of ['claude', 'openai'] as const) {
        try {
          await step.do(`avaliar (${who}) ${id}`, RETRY, () => judge(this.env, id, who));
        } catch {
          // Um juiz em falha não trava a recolha: a resposta fica avaliada pelo outro e vai a revisão.
        }
      }
      await step.do(`juntar ${id}`, RETRY, () => merge(this.env, id, month));
      await step.do(`farmacovigilância ${id}`, RETRY, () => flagFv(this.env, id));
    }
    // Protocolo de farmacovigilância: os sinais novos seguem por email logo que a pergunta termina.
    await step.do('enviar alertas de farmacovigilância', RETRY, async () => { await notifyFv(this.env); });

    const p = await step.do('progresso', () => markDone(this.env, runId));
    await step.do('pontuar', RETRY, () => completeIfDone(this.env, runId, p));
    return { questionId, respostas: ids.length };
  }
}

// Avalia uma resposta recolhida manualmente (Copilot, AI Overviews, Meta AI) e atualiza o índice.
export class EvalWorkflow extends WorkflowEntrypoint<Env, EvalParams> {
  async run(event: WorkflowEvent<EvalParams>, step: WorkflowStep) {
    const { runId, responseId } = event.payload;
    const month = await step.do('mês da recolha', () => monthOf(this.env, runId));
    for (const who of ['claude', 'openai'] as const) {
      try {
        await step.do(`avaliar (${who})`, RETRY, () => judge(this.env, responseId, who));
      } catch {
        /* ver comentário acima */
      }
    }
    await step.do('juntar', RETRY, () => merge(this.env, responseId, month));
    await step.do('farmacovigilância', RETRY, () => flagFv(this.env, responseId));
    await step.do('enviar alertas de farmacovigilância', RETRY, async () => { await notifyFv(this.env); });
    await step.do('pontuar', RETRY, () => score(this.env, runId));
    return { responseId };
  }
}
