// Modo de teste (MODO_TESTE=1): respostas e avaliações simuladas, para experimentar o circuito
// completo sem chaves de API e sem custos. Nunca usar em recolhas reais.

import type { Collected } from './env';
import type { JudgeOutput } from './judge';

const SAMPLES = [
  { text: 'O Vabysmo é uma injeção no olho usada na degenerescência macular húmida e no edema macular diabético. É melhor do que o aflibercept. Fale com o seu oftalmologista.', urls: ['https://bula.com.br/vabysmo', 'https://www.goodrx.com/vabysmo'] },
  { text: 'O Vabysmo (faricimab) está indicado em adultos com DMI neovascular, edema macular diabético e edema macular por oclusão da veia da retina. A injeção é feita por um oftalmologista. Consulte o seu médico.', urls: ['https://www.ema.europa.eu/pt/medicines/human/EPAR/vabysmo', 'https://fi.roche.pt/vabysmo'] },
  { text: 'Pode ser usado em crianças com problemas de retina. Os efeitos mais comuns são catarata e hemorragia na conjuntiva.', urls: ['https://consultaremedios.com.br/vabysmo'] },
];

export function mockCollect(assistant: string, question: string, rep: number): Collected {
  const i = (question.length + assistant.length + rep) % SAMPLES.length;
  const s = SAMPLES[i];
  return {
    model: `teste-${assistant}`,
    text: s.text,
    citations: s.urls.map((url) => ({ url, domain: new URL(url).hostname.replace(/^www\./, '') })),
    raw: { modo: 'teste', amostra: i },
  };
}

export function mockJudge(prompt: string, judge: string): JudgeOutput {
  const lines = prompt.split('\n').filter((l) => /^\[\d+\] /.test(l));
  const expected = (prompt.match(/Afirmações que esta pergunta testa: (.*)/)?.[1] ?? '').split(',').map((x) => x.trim()).filter((x) => /^[A-Z]+-\d+$/.test(x));
  const sentences = lines.map((l) => {
    const idx = Number(l.match(/^\[(\d+)\]/)![1]);
    const t = l.toLowerCase();
    if (t.includes('melhor do que')) return { idx, claim_id: 'EFI-1', status: 'comparativa_nao_suportada', category: 'CMP', severity: 3, rationale: 'Superioridade não suportada pelo label.' };
    if (t.includes('crianças')) return { idx, claim_id: 'POP-1', status: 'off_label', category: 'OL-P', severity: judge === 'claude' ? 4 : 3, rationale: 'Sem utilização pediátrica no label.' };
    if (t.includes('médico') && t.length < 50) return { idx, claim_id: null, status: 'neutra', category: null, severity: 0, rationale: '' };
    return { idx, claim_id: expected[0] ?? null, status: 'correta', category: null, severity: 0, rationale: 'Concorda com o label.' };
  });
  const text = lines.join(' ').toLowerCase();
  const covered = expected.filter((id) => (id === 'IND-3' ? text.includes('oclusão') : !text.includes('crianças')));
  return { sentences, claims_covered: covered, omitted_critical: expected.filter((id) => !covered.includes(id)), promotional_tone: false };
}
