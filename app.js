/* 话苗 demo v2 —— 微信式沉浸演练引擎
 * 三层：①确定性规则层（意图分类/静默暗记/推进/打分，全本地）
 *      ②RAG 接地层（本地检索通报语料，注入 LLM 提示词）
 *      ③大模型层（可选：OpenAI 兼容接口，只负责"措辞"，不负责流程；超时自动降级，不空等）
 * 伦理：暗记全程静默；结算报告一次性揭晓。 */
const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('userInput'), sendBtn = $('sendBtn');
const PEER = SCRIPT.meta.contact_name.split('｜')[0];   // 顶栏只显示备注名（真实微信）
const state = { round: 0, inRound: 0, score: 100, seenRound: null, rows: [], dedByElem: {}, used: {},
  history: [], lastPeerText: '', lastUserAt: 0, lastTimeAt: 0, t0: 0,
  engineCount: { llm: 0, local: 0, fallback: 0 }, done: false };
const LLM = JSON.parse(localStorage.getItem('hm_llm') || 'null') || { base:'', model:'', key:'' };

/* ---------- 意图分类（确定性） ---------- */
const RX = {
  refuse:   /(不做|不干|不要吧|不感兴趣|就是诈骗|是诈骗|骗人的|骗子|报警|96110|拉黑你|不可能|我不会给你|拒绝|再见|算了算了|别骗了|已读不给)/,
  doubt:    /(真的假的|靠谱吗|是不是骗|不会是骗|安全吗|可信吗|怀疑|哪有那么好|正规吗|假的吧|怎么感觉)/,
  identity: /(你是谁|哪个公司|什么公司|公司叫|工号|资质|营业执照|平台叫什么|怎么称呼|你们是谁|在哪办公)/,
  price:    /(赚多少|多少钱|一天能|收益|佣金多少|能赚|工资|报酬|日入|提成|返多少|多少返)/,
  how:      /(怎么做|怎么玩|什么任务|怎么操作|流程|怎么接|需要什么|怎么填|怎么弄|步骤)/,
  consent:  /(好啊|好的|可以啊|行吧|嗯嗯|进群|下载|发我试试|做吧|开始吧|报名|同意|ok|OK|收到|转了|转给你|付款|扫码|扫了|垫付|给你|发你验证码|\d{6})/
};
const HARD = {
  E5: t => /\d{6}/.test(t) || /验证码.{0,10}(是|给|发|收)/.test(t) || /(发你|给你|报).{0,4}(验证码|6位)/.test(t),
  E6: t => /(转|付|扫|垫).{0,8}(了|吧|款|钱|给你|过去)|同意转账|已付款|已转账/.test(t),
  E4: t => /共享屏幕|屏幕共享|远程协助|远程控制/.test(t)
};
const SOFT = {
  E7: t => /(进群|加群|下载|装一?个|换)[^。？！]{0,6}(吧|好|了|可以|嗯|哦)|(好|行|嗯|ok|可以|走)[^。？！]{0,6}(进群|加群|下载)|群号多少|好呀|好啊|可以啊/.test(t),
  E3: t => /(接了|做完|试一单|来一单|接单|做一单|领取)/.test(t),
  E1: t => /马上(转|付|做|去)|快点|赶紧|现在就|立刻/.test(t),
  E2: t => /你们公司|你是谁|工号|授权/.test(t)
};
function intentOf(t){
  if (HARD.E5(t) || HARD.E6(t)) return 'consent';       // 硬指标行为=上钩
  for (const k of ['refuse','doubt','identity','price','how']) if (RX[k].test(t)) return k;
  if (RX.consent.test(t)) return 'consent';
  return 'smalltalk';
}
function watchSilent(t){
  const r = SCRIPT.rounds[state.round], notes = [], byElem = {};
  const entries = [...(r.watch||[])];
  // 硬指标全局生效：验证码/转账/屏幕共享任何时候交出都算失守（反诈教育本义）
  [['E5',4],['E6',5],['E4',4]].forEach(([el,sev]) => {
    if (!entries.some(w => w.element === el)) entries.push({ element: el, severity: sev, hard: true });
  });
  entries.forEach(w => {
    const m = (w.hard ? HARD : SOFT)[w.element];
    if (m && m(t)) {
      const d = (w.hard ? 8 : 2) * w.severity;
      if (!byElem[w.element] || d > byElem[w.element].d) byElem[w.element] = { el:w.element, name:SCRIPT.element_codes[w.element].name, d, hard:!!w.hard };
    }
  });
  Object.values(byElem).forEach(n => {
    notes.push(n); state.score = Math.max(0, state.score - n.d);
    state.dedByElem[n.el] = (state.dedByElem[n.el]||0) + n.d;
  });
  return notes;
}

/* ---------- 渲染原语 ---------- */
function el(tag, cls, html){ const d=document.createElement(tag); if(cls)d.className=cls; if(html!=null)d.innerHTML=html; return d; }
const AVA_PEER = '<svg class="ava" viewBox="0 0 38 38"><rect width="38" height="38" rx="5" fill="#5B7BD5"/><circle cx="19" cy="15" r="6.2" fill="#E8EEFF"/><path d="M6 34c2.2-7.3 7-10.8 13-10.8S29.8 26.7 32 34" fill="#E8EEFF"/></svg>';
const AVA_ME = '<svg class="ava" viewBox="0 0 38 38"><rect width="38" height="38" rx="5" fill="#07C160"/><text x="19" y="25" text-anchor="middle" font-size="17" fill="#FFF" font-family="PingFang SC,Microsoft YaHei">苗</text></svg>';
function fmtTime(d){ return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function timeDiv(){ state.lastTimeAt = Date.now(); chat.appendChild(el('div','time-div',fmtTime(new Date()))); scroll(); }
function maybeTimeDiv(){ if (Date.now() - state.lastTimeAt >= 5*60*1000) timeDiv(); }  // 微信规则：间隔≥5分钟才再显示
function row(side, text){
  const r = el('div','row'+(side==='me'?' me':''));
  r.innerHTML = (side==='me'?AVA_ME:AVA_PEER);
  const b = el('div','bubble'); b.textContent = text;
  r.appendChild(b); chat.appendChild(r);
  if (side==='peer') { state.lastPeerText = text; }
  scroll(); return b;
}
function scroll(){ chat.scrollTop = chat.scrollHeight; }

/* ---------- 微信"对方正在输入…"规则：仅在你发言后 10 秒窗口内出现 ---------- */
let typingShown = false;
function showTyping(){
  if (Date.now() - state.lastUserAt > 10000) return;
  if (!typingShown) { $('contactName').textContent = '对方正在输入…'; typingShown = true; }
}
function hideTyping(){ if (typingShown) { $('contactName').textContent = PEER; typingShown = false; } }
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 消息串行队列：用户可连续发言，对方回复按序送达不互相打断 ---------- */
let q = Promise.resolve();
function enqueue(task){ q = q.then(()=>task().catch(err=>console.error(err))); return q; }

/* ---------- 分条气泡：真人微信不会一次发一大段 ---------- */
function splitBubbles(text){
  const segs = text.match(/[^。！？!?；;，,]+[。！？!?；;，,]?/g) || [text];
  const out = [];
  for (const s of segs) {
    if (out.length && (out[out.length-1].length + s.length) <= 26) out[out.length-1] += s;
    else out.push(s);
  }
  if (out.length > 3) { const head = out.slice(0,2); return [...head, out.slice(2).join('')].map(trimTail); }
  return out.map(trimTail);
}
// 真人微信短句结尾不带逗号
function trimTail(s){ return s.replace(/[，、；,]+$/, ''); }
async function peerBubble(text){
  showTyping();
  const d = Math.min(450 + text.length*24 + Math.random()*300, 2400);
  await wait(d);
  hideTyping(); maybeTimeDiv(); row('peer', text);
}
async function peerStream(text){
  const parts = splitBubbles(text);
  for (let i = 0; i < parts.length; i++) {
    if (i) await wait(320 + Math.random()*380);
    await peerBubble(parts[i]);
  }
}

/* ---------- 台词选择（桶内随机不重样） ---------- */
function pick(bucket){
  const r = SCRIPT.rounds[state.round], arr = r.lines[bucket] || r.lines.smalltalk;
  const used = state.used[state.round + bucket] || (state.used[state.round + bucket] = []);
  const pool = arr.map((v,i)=>i).filter(i=>!used.includes(i));
  const i = pool.length ? pool[Math.floor(Math.random()*pool.length)] : Math.floor(Math.random()*arr.length);
  if(!pool.length) state.used[state.round+bucket] = [];
  state.used[state.round+bucket].push(i);
  return arr[i];
}

/* ---------- LLM 层（可选，只管措辞；8 秒超时自动降级本机引擎，绝不空等） ---------- */
async function llmReply(userText){
  if (!LLM.key) return null;
  const r = SCRIPT.rounds[state.round];
  const ground = retrieveGrounding(userText);
  const sys = '你正在扮演反诈教育模拟中的"兼职刷单骗手"，与一名大学生在微信上聊天。'
    + '当前阶段：第'+r.round_id+'轮·'+r.stage+'（总5轮），本阶段目标：'+r.goal+'。硬性规则：'
    + '1)绝不承认自己是AI或演员，始终以真人兼职对接的口吻说话；'
    + '2)只推进本阶段目标，不越级谈后面阶段的内容；'
    + '3)回复拆成1-3条短消息，每条不超过25字，用换行分隔，口语化、像真人微信消息；'
    + '4)不提供任何真实收款方式，收款码一律用"(图)"指代；'
    + '5)对方质疑时按骗术逻辑辩解，不得人身威胁；'
    + (ground? '6)语气与结构可参考以下真实公开案例的话术片段，但不要照抄原文：\n' + ground.map(c=>'- '+c.text).join('\n') : '');
  try {
    const ac = new AbortController(); const tid = setTimeout(()=>ac.abort(), 8000);
    const res = await fetch(LLM.base.replace(/\/+$/,'') + '/chat/completions', {
      method:'POST', signal:ac.signal,
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+LLM.key },
      body: JSON.stringify({ model: LLM.model, temperature: 0.95, max_tokens: 130,
        messages: [ {role:'system', content: sys},
          ...state.history.slice(-8).map(h=>({role:h.role, content:h.content})),
          {role:'user', content:userText} ] })
    });
    clearTimeout(tid);
    const j = await res.json();
    const text = (j.choices?.[0]?.message?.content || '').trim();
    return text || null;
  } catch(e){ state.engineCount.fallback++; return null; }
}

/* ---------- 主流程 ---------- */
function advance(){
  enqueue(async ()=>{
    state.round++; state.inRound = 0;
    if (state.round >= SCRIPT.rounds.length){ settle('对话自然结束'); return; }
    await peerStream(pick('open'));
  });
}
function onSend(){
  const t = input.value.trim(); if(!t || state.done) return;
  input.value=''; syncSendBtn();
  meSay(t);
  state.lastUserAt = Date.now(); maybeTimeDiv();
  const intent = intentOf(t);
  const notes = watchSilent(t);
  state.history.push({role:'user', content:t});
  const r = SCRIPT.rounds[state.round];
  const finalRound = state.round === SCRIPT.rounds.length - 1;
  const peerPrompt = state.lastPeerText;
  state.rows.push({ round:r.round_id, stage:r.stage, peer:peerPrompt, mine:t, intent,
    verdict: {refuse:'S3 识破', doubt:'S2 起疑', smalltalk:'S1 游离', consent:'S0 参与', how:'S0 参与', price:'S0 参与', identity:'S0 参与'}[intent],
    notes, ded: notes.reduce((s,n)=>s+n.d,0), defense:r.defense });
  if (intent==='refuse' && state.seenRound===null) state.seenRound = r.round_id;
  const engaged = intent==='consent' || HARD.E5(t) || HARD.E6(t);

  enqueue(async ()=>{
    let text = await llmReply(t);
    const bucket = ({refuse:'refuse', doubt:'doubt', identity:'identity', price:'price', how:'how', consent:'consent', smalltalk:'smalltalk'})[intent];
    if (text) state.engineCount.llm++; else { text = pick(bucket); state.engineCount.local++; }
    await peerStream(text);
    state.history.push({role:'assistant', content:text});

    if (finalRound){
      await wait(600);
      settle(engaged ? '对方完成收网诱导（剧本终点）' : (intent==='refuse' ? '你识破并拒绝了对方' : '对话结束'));
      return;
    }
    if (intent==='refuse' || engaged){ state.inRound=0; advance(); return; }
    state.inRound++;
    if (state.inRound >= 3){                              // 停滞太久：骗手主动推进到下一阶段
      state.inRound = 0; advance();
    }
  });
}
function meSay(text){ row('me', text); }

/* ---------- 结算报告 ---------- */
function settle(reason){
  if (state.done) return; state.done = true; hideTyping();
  $('chatView').classList.remove('on');
  const R = $('report'); R.classList.add('on');
  const score = state.score;
  const vCls = score>=80?'v-good':score>=50?'v-mid':'v-bad';
  const verdict = score>=80 ? '免疫力良好<br>继续保持' : score>=50 ? '存在明显失守点<br>建议再练一次' : '高易感<br>请务必看完逐轮复盘';
  const dedList = Object.entries(state.dedByElem).sort((a,b)=>b[1]-a[1]);
  const tops = dedList.slice(0,3).map(([e,d])=>'<span class="tag-i">'+SCRIPT.element_codes[e].name+'（−'+d+'）</span>').join('');
  const formula = dedList.length
    ? '100 − ' + dedList.map(([e,d])=>'<span class="neg">'+SCRIPT.element_codes[e].name+' '+d+'</span>').join(' − ') + ' = <b>'+score+'</b>'
    : '全程未触发风险暗记，基础分 100 保持';
  const seen = state.seenRound ? '首次识破：第 '+state.seenRound+' 轮' : '全程未识破对方话术';
  const secs = Math.max(1, Math.round((Date.now()-state.t0)/1000));
  const dur = secs>=60 ? Math.floor(secs/60)+'分'+String(secs%60).padStart(2,'0')+'秒' : secs+'秒';
  const now = new Date();
  const chipCls = {S3:'s3',S2:'s2',S1:'s1',S0:'s0'};
  R.innerHTML =
    '<div class="rp-head">'
    + '<div class="rp-brand"><svg width="18" height="18" viewBox="0 0 72 72" fill="none"><rect x="4" y="4" width="64" height="64" rx="14" fill="#4A6CF7"/><path d="M36 52c0-12 4-20 14-26" stroke="#FFF" stroke-width="5" stroke-linecap="round"/><path d="M36 52c0-10-3-17-12-22" stroke="#BBD0FF" stroke-width="5" stroke-linecap="round"/><path d="M50 26c4-6 10-8 16-7-1 6-5 11-12 12" fill="#BBD0FF"/></svg>话苗 HUAMIAO</div>'
    + '<div class="rp-title">防骗免疫力报告</div>'
    + '<div class="rp-meta">剧本 '+SCRIPT.meta.script_id+' · '+SCRIPT.meta.strain+' ｜ '+seen+' · '+reason+'<br>用时 '+dur+' ｜ '+now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0')+' '+fmtTime(now)+' · 演示版</div></div>'
    + '<div class="card rp-score"><div class="score-row"><span class="score-n">'+score+'</span><span class="score-d">/100</span>'
    + '<span class="score-verdict '+vCls+'">'+verdict+'</span></div>'
    + '<div class="band"><i style="width:'+score+'%"></i><u style="left:50%"></u><u style="left:80%"></u></div>'
    + '<div class="band-l"><span>高易感</span><span>有失守</span><span>良好</span></div>'
    + '<div class="formula">'+formula+'</div></div>'
    + '<div class="card"><h2>你最易失守的话术</h2><div class="tags">'+(tops||'<span class="tag-i tag-ok">本局未失守</span>')+'</div>'
    + '<p class="disc">演示版扣分为固定权重；正式版权重 = 该话术要素在 80–100 篇公开判决书中的出现频率 × 致损关键度（2人独立评级），权重表全文公开。</p></div>'
    + '<div class="card"><h2>逐轮复盘 · 每一句都被记下来了</h2>'
    + (state.rows.length ? state.rows.map(x=>
        '<div class="rc"><div class="rc-h"><span class="rc-r">第'+x.round+'轮 · '+x.stage+'</span>'
        + '<span class="chip '+chipCls[x.verdict.slice(0,2)]+'">'+x.verdict+'</span>'
        + '<span class="ded-n'+(x.ded?'':' zero')+'">'+(x.ded?'−'+x.ded:'未扣分')+'</span></div>'
        + (x.peer?'<div class="rc-q"><b>对方说</b><p>'+esc(x.peer.length>64?x.peer.slice(0,64)+'…':x.peer)+'</p></div>':'')
        + '<div class="rc-a"><b>你回应</b><p>'+esc(x.mine)+'</p></div>'
        + '<div class="rc-m"><b>风险暗记</b><p class="'+(x.notes.length?'hit':'')+'">'+(x.notes.length?x.notes.map(n=>n.name+'（−'+n.d+'）').join('、'):'本轮未触发')+'</p></div>'
        + '<div class="rc-d"><b>本可这样破</b><div><p>'+esc(x.defense.break)+'</p><p class="cor">'+esc(x.defense.correct)+'</p></div></div></div>').join('')
      : '<p class="disc">你在对方开口前就结束了演练，无逐轮记录。</p>')
    + '</div>'
    + '<div class="card"><h2>反诈要点（话苗必读）</h2><ul class="tips">'
    + '<li>验证码 = 账号与资金的一次性钥匙，任何索要场景都是诈骗。</li>'
    + '<li>所有"先垫付/先付费再返钱"的兼职与刷单都是诈骗，可拨打 96110 核实。</li>'
    + '<li>陌生"客服"提到屏幕共享、退款理赔，立即挂断并走官方 App 求证。</li></ul></div>'
    + '<div class="r-btns"><button id="againBtn">再练一次</button><button id="quitAll">返回须知页</button></div>'
    + '<p class="engine-note">本局对方台词：大模型生成 '+state.engineCount.llm+' 条 · 本机引擎 '+state.engineCount.local+' 条'+(state.engineCount.fallback?'（另有 '+state.engineCount.fallback+' 次接口超时已自动降级）':'')+'<br>推进与打分为本地确定性逻辑 ｜ 全程对话已去标识，仅用于反诈教育研究</p>';
  $('againBtn').onclick = ()=>location.reload();
  $('quitAll').onclick = ()=>{ R.classList.remove('on'); R.innerHTML=''; $('consent').classList.add('on'); resetAll(); };
  R.scrollTop = 0;
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function resetAll(){
  Object.assign(state,{round:0,inRound:0,score:100,seenRound:null,rows:[],dedByElem:{},used:{},history:[],
    lastPeerText:'',lastUserAt:0,lastTimeAt:0,t0:0,engineCount:{llm:0,local:0,fallback:0},done:false});
  chat.innerHTML='';
}

/* ---------- 视图切换与事件 ---------- */
function refreshEngineLine(){
  const on = !!LLM.key;
  $('engineDot').className = 'dot' + (on?' on':'');
  $('engineText').textContent = on ? ('智能引擎：大模型已接入（'+ (LLM.model||'custom') +'）·剧本约束+语料接地') : '智能引擎：本机剧本引擎（可接入大模型增强）';
}
$('startBtn').onclick = ()=>{
  $('consent').classList.remove('on'); $('chatView').classList.add('on');
  $('contactName').textContent = PEER;
  state.t0 = Date.now();
  timeDiv();
  enqueue(async ()=>{
    await peerBubble('在吗？');
    await wait(400 + Math.random()*400);
    await peerStream(SCRIPT.rounds[0].lines.open[0]);
  });
  input.focus({preventScroll:true});
};
$('menuBtn').onclick = ()=> $('menu').classList.add('on');
$('menuCancel').onclick = ()=> $('menu').classList.remove('on');
$('menu').onclick = e => { if(e.target.id==='menu') $('menu').classList.remove('on'); };
$('endEarly').onclick = ()=>{ $('menu').classList.remove('on'); settle('你主动结束并退出'); };
$('aboutItem').onclick = ()=>{ $('menu').classList.remove('on'); enqueue(async()=>{ await peerBubble('（演示提示）本对话为「话苗」AI 骗术对抗演练，对方为按剧本行事的语言模型；结束后可查看防骗免疫力报告。'); }); };
$('backBtn').onclick = ()=>{ if(!state.done) $('exitDlg').classList.add('on'); };
$('exitStay').onclick = ()=>{ $('exitDlg').classList.remove('on'); input.focus({preventScroll:true}); };
$('exitEnd').onclick = ()=>{ $('exitDlg').classList.remove('on'); settle('你主动结束并退出'); };
$('llmCfgBtn').onclick = ()=>{ $('llmBase').value=LLM.base; $('llmModel').value=LLM.model; $('llmKey').value=LLM.key; $('llmSheet').classList.add('on'); };
$('llmSave').onclick = ()=>{
  LLM.base=$('llmBase').value.trim(); LLM.model=$('llmModel').value.trim(); LLM.key=$('llmKey').value.trim();
  if(LLM.key && !LLM.base) LLM.base='https://api.deepseek.com';
  if(!LLM.key){ LLM.base=''; LLM.model=''; }
  localStorage.setItem('hm_llm', JSON.stringify(LLM));
  $('llmSheet').classList.remove('on'); refreshEngineLine();
};
$('llmClear').onclick = ()=>{ localStorage.removeItem('hm_llm'); LLM.base=LLM.model=LLM.key=''; $('llmSheet').classList.remove('on'); refreshEngineLine(); };
$('llmSheet').onclick = e => { if(e.target.id==='llmSheet') $('llmSheet').classList.remove('on'); };
function syncSendBtn(){
  const has = !!input.value.trim();
  sendBtn.style.display = has ? 'block' : 'none';
  $('plusBtn').style.display = has ? 'none' : 'flex';
}
input.addEventListener('input', syncSendBtn);
input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); onSend(); } });
sendBtn.addEventListener('click', onSend);
refreshEngineLine();

/* ---------- 软键盘避让：visualViewport 收缩时抬高会话壳 ---------- */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = ()=>{ document.documentElement.style.setProperty('--vvh', Math.round(vv.height)+'px'); if($('chatView').classList.contains('on')) scroll(); };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}

/* ---------- ⊕ 功能面板与模拟转账 ---------- */
function toast(msg){
  const t = el('div','toast', msg); document.querySelector('.phone').appendChild(t);
  requestAnimationFrame(()=>t.classList.add('on'));
  setTimeout(()=>{ t.classList.remove('on'); setTimeout(()=>t.remove(), 300); }, 1600);
}
$('plusBtn').onclick = ()=> $('plus').classList.add('on');
$('plus').onclick = e => { if(e.target.id==='plus') $('plus').classList.remove('on'); };
document.querySelectorAll('#plus .pi').forEach(b => {
  b.addEventListener('click', ()=>{
    if (b.dataset.k !== '转账'){ toast('演示版未开通「'+b.dataset.k+'」，仅「转账」可体验'); return; }
    $('plus').classList.remove('on');
    $('tName').textContent = PEER;
    $('tAmount').value=''; $('tNote').value=''; $('tGo').disabled = true;
    $('transfer').classList.add('on');
  });
});
$('tAmount').addEventListener('input', ()=>{
  const v = parseFloat($('tAmount').value);
  $('tGo').disabled = !(v > 0);
});
$('tBack').onclick = ()=> $('transfer').classList.remove('on');
$('tGo').onclick = ()=>{
  const amt = parseFloat($('tAmount').value);
  if (!(amt > 0)) return;
  $('transfer').classList.remove('on');
  doTransfer(amt.toFixed(2).replace(/\.00$/,''));
};
function doTransfer(amount){
  if (state.done) return;
  // 橙色转账气泡（我方消息，真实微信样式：金额 + 微信转账）
  const r = el('div','row me'); r.innerHTML = AVA_ME;
  const card = el('div','tcard','<div class="tc-amt">¥'+amount+'</div><div class="tc-sub">微信转账</div>');
  r.appendChild(card); chat.appendChild(r); scroll();
  // 引擎：E6 硬指标全局暗记
  const d = 8 * 5;
  state.score = Math.max(0, state.score - d);
  state.dedByElem.E6 = (state.dedByElem.E6||0) + d;
  const r2 = SCRIPT.rounds[state.round];
  state.history.push({role:'user', content:'【转账】¥'+amount});
  state.rows.push({ round:r2.round_id, stage:r2.stage, peer:state.lastPeerText, mine:'转账 ¥'+amount+'（模拟）', intent:'consent',
    verdict:'S0 参与', notes:[{el:'E6', name:SCRIPT.element_codes.E6.name, d, hard:true}], ded:d, defense:r2.defense });
  enqueue(async ()=>{
    await peerStream(pick('consent'));
    if (state.round === SCRIPT.rounds.length - 1) settle('对方完成收网诱导（模拟转账完成）');
    else { state.inRound = 0; advance(); }
  });
}
