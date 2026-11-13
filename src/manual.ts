// Página de recolha manual (Copilot, Google AI Overviews, Meta AI): quem recolhe faz a pergunta no assistente,
// cola a resposta e as fontes, e a resposta entra na mesma avaliação que as recolhidas por API.
// A página não traz dados: só funciona com o token de acesso, que fica guardado apenas neste separador.

export const MANUAL_HTML = `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Recolha manual · Observatório IA</title>
<style>
:root{--bg:#f5f5f7;--c:#fff;--t:#1d1d1f;--t2:#6e6e73;--h:#d2d2d7;--b:#0071e3;--ok:#34c759;--r:#ff3b30}
@media (prefers-color-scheme:dark){:root{--bg:#000;--c:#1c1c1e;--t:#f5f5f7;--t2:#a1a1a6;--h:#38383a;--b:#2997ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:32px;letter-spacing:-.02em;margin:0 0 6px}p{margin:0}
.k{color:var(--t2);font-size:14px}.card{background:var(--c);border-radius:16px;padding:18px;margin-top:14px}
label{display:block;font-size:13px;color:var(--t2);margin:10px 0 4px}input,select,textarea{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--h);border-radius:10px;padding:10px}
textarea{min-height:120px;resize:vertical}button{font:inherit;border:0;border-radius:99px;padding:9px 18px;background:var(--b);color:#fff;cursor:pointer}
button.sec{background:transparent;color:var(--b);border:1px solid var(--b)}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.row>*{flex:1;min-width:180px}.row>button{flex:0 0 auto}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:var(--bg);color:var(--t2);margin-right:6px}
.q{font-size:18px;font-weight:600;margin:8px 0}.msg{font-size:14px;margin-top:8px}.ok{color:var(--ok)}.err{color:var(--r)}
.done{opacity:.55}
</style></head><body><main>
<h1>Recolha manual</h1>
<p class="k">Para os assistentes sem API. Protocolo: sessão nova, sem conta pessoal, localização em Portugal. Copiar a resposta completa e as fontes citadas.</p>
<div class="card"><div class="row">
<div><label for="tok">Token de acesso</label><input id="tok" type="password" autocomplete="off"></div>
<div><label for="brand">Marca</label><select id="brand"><option value="">Carregar marcas</option></select></div>
<div><label for="run">Recolha</label><select id="run"></select></div>
<button id="load">Ver tarefas</button></div><p id="status" class="msg k"></p></div>
<div id="tasks"></div>
</main><script>
const $=(s)=>document.querySelector(s);const api=async(p,o={})=>{const r=await fetch(p,{...o,headers:{authorization:'Bearer '+$('#tok').value.trim(),'content-type':'application/json'}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.erro||('Erro '+r.status));return j};
const LABEL={copilot:'Microsoft Copilot',ai_overviews:'Google AI Overviews',meta_ai:'Meta AI'};
try{const t=sessionStorage.getItem('obs-tok');if(t)$('#tok').value=t}catch(e){}
function status(t,c){const s=$('#status');s.textContent=t;s.className='msg '+(c||'k')}
async function loadBrands(){try{try{sessionStorage.setItem('obs-tok',$('#tok').value.trim())}catch(e){}
const b=await api('/api/brands');$('#brand').innerHTML=b.map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('');await loadRuns();status('')}catch(e){status(e.message,'err')}}
async function loadRuns(){const r=await api('/api/runs?brand_id='+encodeURIComponent($('#brand').value));$('#run').innerHTML=r.map(x=>'<option value="'+x.id+'">'+x.month+' · '+x.id+'</option>').join('')}
$('#tok').addEventListener('change',loadBrands);$('#brand').addEventListener('change',()=>loadRuns().catch(e=>status(e.message,'err')));
$('#load').addEventListener('click',async()=>{try{if(!$('#run').value)await loadBrands();const j=await api('/api/manual-tasks?run_id='+encodeURIComponent($('#run').value));render(j);status(j.tarefas.length?j.tarefas.length+' tarefas por fazer':'Não há tarefas por fazer nesta recolha.','ok')}catch(e){status(e.message,'err')}});
function render(j){const host=$('#tasks');host.innerHTML='';j.tarefas.forEach((t,i)=>{const d=document.createElement('div');d.className='card';
d.innerHTML='<span class="tag">'+(LABEL[t.assistant]||t.assistant)+'</span><span class="tag">'+t.question_id+'</span><p class="q"></p>'+
'<div class="row"><button class="sec cp">Copiar pergunta</button></div><label>Resposta completa</label><textarea class="tx"></textarea>'+
'<label>Fontes citadas (um link por linha)</label><textarea class="src" style="min-height:70px"></textarea><div class="row" style="margin-top:10px"><button class="go">Enviar para avaliação</button></div><p class="msg"></p>';
d.querySelector('.q').textContent=t.pergunta;
d.querySelector('.cp').onclick=()=>navigator.clipboard.writeText(t.pergunta).then(()=>{d.querySelector('.msg').textContent='Pergunta copiada.'});
d.querySelector('.go').onclick=async(ev)=>{const text=d.querySelector('.tx').value.trim();if(text.length<20){d.querySelector('.msg').textContent='Cole a resposta completa.';d.querySelector('.msg').className='msg err';return}
ev.target.disabled=true;const citations=d.querySelector('.src').value.split(/\\s+/).filter(u=>/^https?:\\/\\//.test(u)).map(url=>({url}));
try{await api('/api/manual-response',{method:'POST',body:JSON.stringify({run_id:j.run_id,question_id:t.question_id,assistant:t.assistant,rep:1,text,citations})});
d.classList.add('done');d.querySelector('.msg').textContent='Enviada. Está a ser avaliada.';d.querySelector('.msg').className='msg ok'}catch(e){ev.target.disabled=false;d.querySelector('.msg').textContent=e.message;d.querySelector('.msg').className='msg err'}};
host.appendChild(d)})}
if($('#tok').value)loadBrands();
</script></body></html>`;
