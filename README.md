# Observatório IA — motor de recolha e análise (Cloudflare)

Todos os meses, este serviço pergunta aos assistentes de IA o que dizem sobre cada marca, compara as respostas com o RCM e guarda tudo no histórico. Corre na tua conta Cloudflare, com os dados guardados na UE.

**O que faz:**

1. **Recolha automática** no ChatGPT, Gemini, Perplexity e Claude, através das APIs oficiais, com localização em Lisboa e 3 repetições por pergunta.
2. **Recolha manual assistida** no Copilot, Google AI Overviews e Meta AI. Estes não têm API equivalente à versão pública: o sistema gera a lista de tarefas e tu (ou alguém da equipa) colas as respostas.
3. **Avaliação frase a frase** contra o mapa do label, feita por dois juízes (Claude e GPT) com a mesma grelha. Quando discordam, ou quando a gravidade é 3 ou 4, a frase vai para revisão humana.
4. **Índice de 0 a 100** por mês, assistente e persona, com os pesos do blueprint.
5. **Achados com histórico:** data em que surgiram, data em que desapareceram, causa provável e ação recomendada.
6. **Base de conhecimento:** registo de domínios citados e padrões de erro, partilhado entre marcas.
7. **Exportação** no formato do dashboard.

---

## Antes de começar

- Uma conta Cloudflare. O plano **Workers Paid** é o recomendado para Workflows com este volume. Confirma os limites e preços em [developers.cloudflare.com/workflows](https://developers.cloudflare.com/workflows/).
- **Node.js 20 ou superior** instalado no Mac. Para verificar, no Terminal: `node -v`.
- Uma chave de API de cada serviço:
  - OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
  - Google Gemini: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  - Perplexity: [perplexity.ai/account/api](https://www.perplexity.ai/account/api)
  - Anthropic: [platform.claude.com](https://platform.claude.com/)

  As chaves da Anthropic e da OpenAI também servem aos juízes. Sem elas, a avaliação não corre.

---

## Publicar, passo a passo

Abre o Terminal na pasta do projeto (`observatorio-ia`) e corre os comandos por ordem.

### 1. Instalar

```bash
npm install
```

### 2. Entrar na conta Cloudflare

```bash
npx wrangler login
```

Abre uma janela do browser para autorizares o acesso.

### 3. Criar a base de dados na UE

```bash
npx wrangler d1 create observatorio-ia --jurisdiction=eu
```

O comando devolve um `database_id`. Abre `wrangler.jsonc` e cola-o no lugar de `COLAR_AQUI_O_ID_DA_BASE_DE_DADOS`.

A jurisdição só pode ser definida na criação: não saltes o `--jurisdiction=eu`.

### 4. Criar o armazenamento das provas na UE

```bash
npx wrangler r2 bucket create observatorio-ia-provas --jurisdiction eu
```

Se o comando não for aceite, cria o bucket no painel da Cloudflare: **R2 → Create bucket**, com o nome `observatorio-ia-provas` e **Location → Specify jurisdiction → European Union**.

### 5. Guardar as chaves (segredos)

Corre um comando de cada vez. Cada um pede-te para colar o valor.

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PERPLEXITY_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

O `API_TOKEN` é uma palavra-passe longa que inventas, por exemplo gerada com `openssl rand -hex 32`. Protege a API do serviço. Guarda-o num gestor de palavras-passe.

Opcional: `READ_TOKEN`, um segundo token só de leitura, para partilhar a exportação sem dar acesso de escrita.

### 6. Criar as tabelas e carregar o Vabysmo

```bash
npm run db:migrate
npm run db:seed
```

O seed carrega o piloto Vabysmo: 17 afirmações do label, as 20 perguntas e a base de conhecimento inicial.

### 7. Publicar

```bash
npm run deploy
```

No fim aparece o endereço do serviço, algo como `https://observatorio-ia.<a-tua-conta>.workers.dev`. Nos exemplos abaixo, substitui `$URL` por esse endereço e `$TOKEN` pelo teu `API_TOKEN`.

### 8. Confirmar que está no ar

```bash
curl $URL/health
```

---

## Fase 1: começar só com ChatGPT e Claude

O projeto vem configurado para recolher só no ChatGPT e no Claude (`ASSISTENTES_API` em `wrangler.jsonc`). No passo 5 bastam três segredos:

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

Estas duas chaves chegam para tudo, incluindo os dois juízes.

**Primeiro teste, o mais barato possível** (1 pergunta, 1 repetição, 2 assistentes):

```bash
curl -X POST $URL/api/runs -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"brand_id":"vabysmo","question_ids":["Q01"],"reps":1}'
```

Passado um minuto, vê o resultado com o `run_id` devolvido:

```bash
curl $URL/api/runs/RUN_ID -H "authorization: Bearer $TOKEN"
```

Se `falhas` vier vazio e `indice` tiver valores para `chatgpt` e `claude`, está tudo a funcionar. Depois disso, corre as 20 perguntas sem `question_ids` nem `reps`.

**Para acrescentar Gemini e Perplexity mais tarde:** guarda as duas chaves com `wrangler secret put`, muda `ASSISTENTES_API` para `"chatgpt,gemini,perplexity,claude"` e corre `npm run deploy`.

Os testes ficam no histórico com `teste` no `run_id`.

---

## Relatórios, farmacovigilância e recolha manual

**Atualizar a base de dados (uma vez):**

```bash
npx wrangler d1 migrations apply observatorio-ia --remote
```

**Emails (Resend):** criar conta em resend.com com getinlinelda@gmail.com, criar uma API key e guardá-la:

```bash
npx wrangler secret put RESEND_API_KEY
```

Sem domínio verificado, a Resend só envia para o email da própria conta. Para enviar a clientes, verificar o domínio (por exemplo getinline.pt) e mudar `EMAIL_FROM` no `wrangler.jsonc`.

**Relatório automático.** Quando uma recolha termina, o sistema cria um link do relatório (sem login) e envia-o para `ALERT_EMAIL`.

- Ver o link: `GET /api/runs/ID` (campo `relatorio`).
- Gerar o link de uma recolha antiga: `POST /api/runs/ID/report` (com `{"email": true}` envia também o email).
- Desativar um link: `POST /api/reports/SHARE_ID` com `{"ativo": false}`; reativar com `{"ativo": true}`.

**Farmacovigilância.** Cada frase com categoria FV (possível evento adverso) ou gravidade 4 (pode levar a dano) fica registada e é enviada por email logo que a pergunta termina. O contacto por marca define-se no campo `alert_email` da marca; se faltar, usa `ALERT_EMAIL`.

- Ver os sinais: `GET /api/fv?brand_id=vabysmo`.
- Reenviar os pendentes: `POST /api/fv/notify`.

**Recolha manual** (Copilot, Google AI Overviews, Meta AI): abrir `https://observatorio-ia.getinlinelda.workers.dev/manual`, colar o token, escolher a marca e a recolha e carregar em "Ver tarefas". Cada resposta enviada entra na mesma avaliação.

## Usar no dia a dia

### Recolha mensal

Corre sozinha no **dia 1 de cada mês às 06:00 UTC**, para todas as marcas ativas. Para mudar a hora ou a frequência, edita `triggers.crons` em `wrangler.jsonc`.

Para arrancar uma recolha à mão:

```bash
curl -X POST $URL/api/runs -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"brand_id":"vabysmo"}'
```

A resposta traz o `run_id`. Para acompanhar o progresso, o índice e as falhas:

```bash
curl $URL/api/runs/RUN_ID -H "authorization: Bearer $TOKEN"
```

### Recolha manual (Copilot, AI Overviews, Meta AI)

1. Pede a lista de tarefas:

   ```bash
   curl "$URL/api/manual-tasks?run_id=RUN_ID" -H "authorization: Bearer $TOKEN"
   ```

2. Para cada tarefa, abre o assistente numa janela privada, sem conta pessoal, faz a pergunta tal como está e copia a resposta completa e as fontes.

3. Envia a resposta:

   ```bash
   curl -X POST $URL/api/manual-response -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"run_id":"RUN_ID","question_id":"Q01","assistant":"copilot","text":"...resposta...","citations":[{"url":"https://...","title":"..."}]}'
   ```

   O valor de `assistant` é `copilot`, `ai_overviews` ou `meta_ai`. A avaliação corre sozinha e o índice atualiza-se.

### Revisão científica

As frases em que os juízes discordam, ou com gravidade 3 ou 4:

```bash
curl "$URL/api/review?brand_id=vabysmo" -H "authorization: Bearer $TOKEN"
```

Para registar a decisão do revisor:

```bash
curl -X POST $URL/api/review -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"response_id":"...","idx":0,"status":"off_label","category":"OL-P","severity":4,"reviewer":"Dr. Nome"}'
```

A decisão entra logo no índice.

### Exportar para o dashboard

```bash
curl $URL/api/export/vabysmo -H "authorization: Bearer $TOKEN" > vabysmo.json
```

O ficheiro tem os blocos `indice`, `alertas`, `achados`, `label`, `perguntas` e `fontes`, no formato do dashboard. Envia-mo e eu atualizo o dashboard.

### Nova marca

1. Criar a marca:

   ```bash
   curl -X POST $URL/api/brands -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"id":"marca-x","name":"Marca X","substance":"...","holder":"...","area":"...","brand_terms":["Marca X","substância"],"official_domains":["site-do-titular.pt"]}'
   ```

2. Extrair o mapa do label a partir do texto do RCM:

   ```bash
   curl -X POST $URL/api/brands/marca-x/extract-claims -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"rcm_text":"...texto do RCM...","rcm_version":"EMA PT 2026-06"}'
   ```

3. Gerar a bateria de perguntas:

   ```bash
   curl -X POST $URL/api/brands/marca-x/generate-questions -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"n":60}'
   ```

   Gera perguntas novas. Para gerar perguntas que testam o label, aprova primeiro as afirmações do passo 2.

4. Rever o que foi proposto:

   ```bash
   curl $URL/api/brands/marca-x/pending -H "authorization: Bearer $TOKEN"
   ```

5. Aprovar, depois de validado pelo revisor científico:

   ```bash
   curl -X POST $URL/api/brands/marca-x/approve -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"claims":"all","questions":"all"}'
   ```

   Também podes aprovar IDs concretos (`"claims":["IND-1","CI-1"]`) ou rejeitá-los (`"claims_reject":["EA-9"]`).

---

## Testar sem gastar

Para correr tudo no teu Mac com respostas e avaliações simuladas, sem chamar APIs:

```bash
cp .dev.vars.example .dev.vars        # e coloca MODO_TESTE=1 e um API_TOKEN qualquer
npx wrangler d1 migrations apply observatorio-ia --local
npx wrangler d1 execute observatorio-ia --local --file=seed/vabysmo.sql
npx wrangler dev
```

O serviço fica em `http://localhost:8787`. Nunca ponhas `MODO_TESTE` na versão publicada.

---

## Ajustes em `wrangler.jsonc`

| Variável | Para que serve |
| --- | --- |
| `REPETICOES` | Vezes que cada pergunta é feita a cada assistente (por defeito 3) |
| `ASSISTENTES_API` | Assistentes recolhidos por API |
| `ASSISTENTES_MANUAIS` | Assistentes recolhidos à mão |
| `OPENAI_MODEL`, `GEMINI_MODEL`, `CLAUDE_MODEL` | Modelos usados para simular o que o público vê |
| `PERPLEXITY_MODEL` | Vazio = o modelo por defeito da Perplexity |
| `JUIZ_CLAUDE_MODEL`, `JUIZ_OPENAI_MODEL` | Modelos que avaliam as respostas |

Quando um assistente lança um modelo novo, muda aqui e volta a publicar. Fica registado em cada resposta, para separar "a marca melhorou" de "o modelo mudou".

---

## O que ainda não está provado

O circuito completo foi testado localmente em modo de teste: recolha, dupla avaliação, revisão, índice, achados e exportação. As chamadas reais às APIs só podem ser testadas com as tuas chaves. Antes da primeira recolha completa:

- **Testa uma pergunta só.** Cria uma marca de teste com uma pergunta aprovada e corre `/api/runs`. Vê em `/api/runs/RUN_ID` se algum assistente aparece em `falhas`. Se aparecer, envia-me a mensagem de erro.
- **API não é igual à app.** As respostas por API podem ser diferentes das que o público vê nas aplicações. Convém comparar uma amostra com recolha manual antes de vender o índice como "o que o público vê".
- **Fontes da OpenAI.** O campo com a lista completa de fontes do ChatGPT está documentado, mas não o seu formato exato. O código lê também as citações no texto, que são sempre devolvidas.
- **Gemini.** O código usa `generateContent`, que a Google marca como legado e ainda suportado. A Google recomenda a nova Interactions API para projetos novos, e a migração pode ser feita mais tarde.
- **Perplexity.** Usa a Agent API, porque a Sonar Chat Completions deixou de ser suportada a 27/09/2026. Confirma na consola da Perplexity qual o modelo que queres medir e coloca-o em `PERPLEXITY_MODEL`.
- **Termos de utilização.** Revê os termos de cada serviço para este uso, sobretudo na recolha manual dos assistentes sem API.
- **Custos.** Cada recolha do piloto Vabysmo (20 perguntas × 4 assistentes × 3 repetições) faz 240 chamadas de recolha e até 480 de avaliação. Com 60 perguntas são 720 e 1.440. Confirma os preços atuais de cada API. A pesquisa web do Claude, por exemplo, custa 10 USD por 1.000 pesquisas, mais os tokens.

---

## Estrutura

```
src/index.ts       API, agendamento mensal e exportação
src/workflows.ts   Workflows: uma instância por pergunta; avaliação de respostas manuais
src/assistants.ts  Adaptadores do ChatGPT, Gemini, Perplexity e Claude
src/judge.ts       Taxonomia de risco, grelha dos juízes e junção das avaliações
src/pipeline.ts    Recolha, avaliação, achados, índice e registo de fontes
src/extract.ts     Extração do label a partir do RCM e geração de perguntas
src/mock.ts        Modo de teste
migrations/        Esquema da base de dados (D1)
seed/              Marca piloto Vabysmo (SQL e JSON)
```
