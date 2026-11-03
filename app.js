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
  engineCount: { llm: 0, local: 0, fail: 0 }, llmErr: '', lastTest: null,
  transcript: [], replayed: null, lastReason: '', done: false };
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
  /* 对话史必须完整：旧版只记用户句与大模型回复，对方的开场白/"在吗？"/罐头台词都没进
   * history，导致接了大模型也看不到自己刚说过什么 → 前后矛盾、重复自我介绍。 */
  state.history.push({ role: side==='peer' ? 'assistant' : 'user', content: text });
  if (state.history.length > 24) state.history.splice(0, state.history.length - 24);
  if (side==='peer') { state.lastPeerText = text; }
  state.transcript.push({ s: side==='peer' ? 'peer' : 'me', t: text });
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
/* ---------- 拟真图片消息：真实骗手发的是截图，不是台词里写一句"（截图）" ---------- */
const wxCard = inner => '<div class="imgcard">' + inner + '</div>';
function poster(kind, ctx) {
  const amtM = (ctx || '').match(/(\d{2,4})\s*(?:元|块)?/);
  const amt = amtM ? amtM[1] : '20';
  if (kind === 'receipt') return wxCard(
    '<div class="pc-h"><svg width="18" height="18" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#07C160"/><path d="M6 10.2l2.6 2.6L14 7.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>微信<span class="pc-sub">服务通知</span></div>'
    + '<div class="pc-amt">¥' + amt + '.00</div><div class="pc-l">转账已到零钱 · 即时到账</div>'
    + '<div class="pc-f">截图 · 样机模拟，非真实到账</div>');
  if (kind === 'group') return wxCard(
    '<div class="pc-h"><span class="pc-g">星速任务群(326)</span></div>'
    + '<div class="pc-m"><b>阿俊·计科2班</b><i>刚做完联单到账180 真的假的这么顺</i></div>'
    + '<div class="pc-m"><b>小鹿·外语2班</b><i>群主说今天只剩2个名额了</i></div>'
    + '<div class="pc-f">截图 · 样机模拟对话，非真实群聊</div>');
  if (kind === 'badge') return wxCard(
    '<div class="pc-h"><span class="pc-g">工牌 · 星速传媒</span></div>'
    + '<div class="pc-m"><b>岗位</b><i>兼职对接专员</i></div>'
    + '<div class="pc-m"><b>工号</b><i>A-2071（自称，未经核验）</i></div>'
    + '<div class="pc-f">截图 · 样机模拟，正规企业不会用这个索财</div>');
  if (kind === 'qr') return wxCard(
    '<div class="qrbox"><svg viewBox="0 0 40 40" width="112" height="112" aria-hidden="true">'
    + '<rect width="40" height="40" fill="#fff"/>'
    + Array.from({length: 13}, (_,y) => Array.from({length:13},(_,x)=>{
        const on = ((x*7+y*11+((x*y)%5)) % 3) === 0;
        return on ? '<rect x="'+(2+x*2.8)+'" y="'+(2+y*2.8)+'" width="2.6" height="2.6" fill="#1A1D26"/>' : '';
      }).join('')).join('')
    + '<rect x="1" y="1" width="8" height="8" fill="none" stroke="#1A1D26" stroke-width="2"/>'
    + '<rect x="31" y="1" width="8" height="8" fill="none" stroke="#1A1D26" stroke-width="2"/>'
    + '<rect x="1" y="31" width="8" height="8" fill="none" stroke="#1A1D26" stroke-width="2"/>'
    + '</svg></div>'
    + '<div class="pc-l">星速传媒商贸有限公司（自称对公码）</div>'
    + '<div class="pc-f">示例码 · 图案由脚本生成，不含任何真实收款信息，不可扫描支付</div>');
  return wxCard('<div class="pc-l">图片消息</div>');
}
function peerImageEl(kind, ctx) {
  const r = el('div', 'row'); r.innerHTML = AVA_PEER;
  const b = el('div', 'bubble img-bubble'); b.innerHTML = poster(kind, ctx);
  r.appendChild(b); chat.appendChild(r);
  const cap = { receipt: '发来一张微信转账到账截图', group: '发来一张任务群聊天截图', badge: '发来一张自称的公司工牌', qr: '发来一张商家收款码图片' };
  state.history.push({ role: 'assistant', content: '[' + (cap[kind] || '发来一张图片') + ']' });
  state.transcript.push({ s: 'peer', img: kind });
  if (state.history.length > 24) state.history.splice(0, state.history.length - 24);
  scroll();
}
async function peerImage(kind, ctx) {
  showTyping();
  await wait(Math.min(450 + 900, 2400));          // 发图比发字慢一拍，更像真人
  hideTyping(); maybeTimeDiv(); peerImageEl(kind, ctx);
}
/* 台词里的文本占位（截图）（图）已统一替换为【图:kind】标记，渲染时拆成图片消息 */
async function peerStream(text){
  const tokens = String(text).split(/(【图:[a-z]+】)/).filter(s => s.trim());
  let first = true;
  for (const tk of tokens) {
    const m = tk.match(/^【图:([a-z]+)】$/);
    const segs = m ? [tk] : splitBubbles(tk);
    for (const s of segs) {
      if (!first) await wait(320 + Math.random() * 380);
      if (m) await peerImage(m[1], text); else await peerBubble(s);
      first = false;
    }
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

/* ---------- LLM 层（可选，只管措辞；8 秒超时自动降级本机引擎，绝不空等） ----------
 * 失败必须可见：接口报错（401/404/402/429）不抛异常，旧代码会把"key 无效/模型名没填"
 * 静默变成本机引擎台词，看起来像"接了大模型但很笨"。现在分类记录，如实计入页脚。 */
async function llmCall(messages, timeoutMs = 8000) {
  if (!LLM.key) return { err: '未配置 API Key' };
  if (!LLM.base) return { err: '未配置接口地址（Base URL）' };
  let res;
  try {
    const ac = new AbortController(); const tid = setTimeout(() => ac.abort(), timeoutMs);
    res = await fetch(LLM.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LLM.key },
      body: JSON.stringify({ model: LLM.model, temperature: 0.95, max_tokens: 130, messages })
    });
    clearTimeout(tid);
  } catch (e) {
    return { err: e && e.name === 'AbortError' ? `接口 ${timeoutMs/1000} 秒未响应（已超时降级）` : '无法连接接口（网络或跨域被拦截）' };
  }
  if (!res.ok) {
    let detail = '';
    try { const b = await res.json(); detail = (b.error && b.error.message) || b.message || JSON.stringify(b); }
    catch (_) { try { detail = (await res.text()).slice(0, 120); } catch (e2) {} }
    const hint = res.status === 401 ? 'Key 无效、已注销或额度用尽'
      : res.status === 402 ? '账户余额不足'
      : res.status === 403 ? '该 Key 无权访问此模型'
      : res.status === 404 ? '接口地址或模型名不存在（检查 Base URL 与模型名拼写）'
      : res.status === 429 ? '请求频率或额度受限' : 'HTTP ' + res.status;
    return { err: hint + (detail ? ' · ' + String(detail).replace(/\s+/g,' ').slice(0, 240) : '') };
  }
  const j = await res.json().catch(() => null);
  if (!j) return { err: '接口返回非 JSON（被代理或网关改写）' };
  const text = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  return text ? { text } : { err: '接口返回空内容（模型名可能不支持对话）' };
}

/* 粘贴掉一位就会报"Key 无效"，而且看不出是自己粘贴错了：实时显示长度与首尾 */
function keyHint() {
  const k = $('llmKey'), box = $('llmKeyHint');
  if (!k || !box) return;
  const v = k.value.trim();
  if (!v) { box.textContent = ''; return; }
  const sp = /\s/.test(k.value) ? ' · 含空格或换行（已忽略）' : '';
  const isSk = v.indexOf('sk-') === 0;
  const warn = !isSk ? ' · 不是 sk- 开头，请确认复制完整' : (v.length !== 35 ? ' —— DeepSeek 的 Key 通常为 35 位，请回平台重新完整复制' : '');
  box.textContent = '当前填入：' + v.slice(0, 4) + '…' + v.slice(-4) + '（长度 ' + v.length + ' 位）' + sp + warn;
}

/* 表单 → 内存：以前「检测连接」只读已保存的配置，用户填完直接点检测会拿旧值去请求，
 * 报出来的 400 与框里的模型名对不上，完全无法自查。 */
function syncLlmFromForm(persist) {
  const b = $('llmBase'), m = $('llmModel'), k = $('llmKey');
  if (!b || !m || !k) return;
  LLM.base = b.value.trim(); LLM.model = m.value.trim(); LLM.key = k.value.trim();
  if (LLM.key && !LLM.base) LLM.base = 'https://api.deepseek.com';
  if (persist) localStorage.setItem('hm_llm', JSON.stringify(LLM));
}

/* 模型名以接口为准，不写死：写死的默认名会随厂商改名而失效 */
async function fetchModels() {
  if (!LLM.base || !LLM.key) return null;
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(LLM.base.replace(/\/+$/, '') + '/models', { headers: { Authorization: 'Bearer ' + LLM.key }, signal: ac.signal });
    clearTimeout(t); if (!res.ok) return null;
    const j = await res.json();
    return (j.data || j.models || []).map(x => x.id || x.name || x.model).filter(Boolean);
  } catch (e) { return null; }
}

/* 配置面板里的「检测连接」：让接入与否在开练之前就确认，而不是靠感觉猜 */
async function testConnection() {
  syncLlmFromForm(false); keyHint();             // 以表单当前值为准，不必先点保存
  const out = $('llmTestResult'); if (out) { out.textContent = '正在请求接口…'; out.className = 'test-result'; }
  let note = '';
  const ping = [{ role: 'user', content: '只回复两个字：正常' }];
  if (LLM.key && !LLM.model) {                  // 模型名留空 → 问接口要，不猜
    const list = await fetchModels();
    if (list && list.length) {
      LLM.model = list.find(id => /flash|lite|turbo|free/i.test(id)) || list[0];
      if ($('llmModel')) $('llmModel').value = LLM.model;
      note = '（模型名留空，已按接口列表选用 ' + LLM.model + '）';
    }
  }
  let r = await llmCall(ping, 12000);
  /* 接口常常在 400 里直接告诉你它支持哪些模型名——照它给的第一条改名重试一次 */
  if (!r.text && /supported .*model names are/i.test(r.err || '')) {
    const m = r.err.match(/model names are\s+([A-Za-z0-9._\-]+)/i);
    if (m && m[1] && m[1] !== LLM.model) {
      const old = LLM.model; LLM.model = m[1]; if ($('llmModel')) $('llmModel').value = m[1];
      const r2 = await llmCall(ping, 12000);
      if (r2.text) { r = r2; note = '（接口只支持 ' + m[1] + '，已从 ' + (old || '空') + ' 改用它后连通）'; }
      else r = r2;
    }
  }
  state.lastTest = r.text ? { ok: true, msg: '模型返回：' + r.text.slice(0, 20) } : { ok: false, msg: r.err };
  if (out) { out.textContent = (r.text ? '✓ 连通 · ' + state.lastTest.msg : '✗ ' + r.err) + (note ? ' ' + note : ''); out.className = 'test-result ' + (r.text ? 'ok' : 'bad'); }
  refreshEngineLine();
  return r;
}

async function llmReply(userText){
  if (!LLM.key) return null;
  const r = SCRIPT.rounds[state.round];
  const ground = retrieveGrounding(userText, {
    strain: SCRIPT.meta.strain,
    elements: [...(r.watch||[]).map(w=>w.element), ...SCRIPT.meta.elements_used]
  });
  const sys = '你正在扮演反诈教育模拟中的"兼职刷单骗手"，与一名大学生在微信上聊天。'
    + '当前阶段：第'+r.round_id+'轮·'+r.stage+'（总5轮），本阶段目标：'+r.goal+'。硬性规则：'
    + '1)绝不承认自己是AI或演员，始终以真人兼职对接的口吻说话；'
    + '2)只推进本阶段目标，不越级谈后面阶段的内容；'
    + '3)回复拆成1-3条短消息，每条不超过25字，用换行分隔，口语化、像真人微信消息；'
    + '4)不提供任何真实收款方式，收款码一律用"(图)"指代；'
    + '5)对方质疑时按骗术逻辑辩解，不得人身威胁；'
    + '6)对方说的话里有具体信息（金额、时间、亲友经历、某个质疑点）时，必须先接住这个信息再推进目标，不许答非所问；'
    + (ground ? '7)语气与结构参考以下真实公开通报案例的话术片段（按本轮话术要素检索得到），不要照抄原文：\n'
        + ground.map(c => '- 【' + c.src + '·' + c.el + '】' + c.text).join('\n') : '');
  const out = await llmCall([
    { role: 'system', content: sys },
    ...state.history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText }
  ]);
  if (out.text) return out.text;
  state.engineCount.fail++; state.llmErr = out.err || '未知错误';
  return null;
}

/* ---------- 主流程 ---------- */
/* 推进必须内联 await，不能 enqueue 到队尾：否则用户连发时，排在前面的发言任务
 * 会在 round 自增之前执行，全部记到同一轮（暗记归错轮、末轮判定失灵）。 */
async function advanceNow(){
  state.round++; state.inRound = 0;
  if (state.round >= SCRIPT.rounds.length){ settle('对话自然结束'); return; }
  await peerStream(pick('open'));
}
function onSend(){
  const t = input.value.trim(); if(!t || state.done) return;
  input.value=''; syncSendBtn();
  meSay(t);
  state.lastUserAt = Date.now(); maybeTimeDiv();
  /* 关键修正：意图判定、暗记归属、轮次推进全部放进串行队列里执行。
   * 旧版在发送瞬间就读 state.round 定 finalRound 与本轮 watch，而 round 是在队列里才自增的——
   * 用户连发两句时，第二句会被记到上一轮：暗记归错轮、末轮判定失灵（演练可能不结算）。 */
  enqueue(async ()=>{
    const intent = intentOf(t);
    const notes = watchSilent(t);
    const r = SCRIPT.rounds[state.round];
    const finalRound = state.round === SCRIPT.rounds.length - 1;
    const peerPrompt = state.lastPeerText;
    state.rows.push({ round:r.round_id, stage:r.stage, peer:peerPrompt, mine:t, intent,
      verdict: {refuse:'S3 识破', doubt:'S2 起疑', smalltalk:'S1 游离', consent:'S0 参与', how:'S0 参与', price:'S0 参与', identity:'S0 参与'}[intent],
      notes, ded: notes.reduce((s,n)=>s+n.d,0), defense:r.defense });
    if (intent==='refuse' && state.seenRound===null) state.seenRound = r.round_id;
    const engaged = intent==='consent' || HARD.E5(t) || HARD.E6(t);
    let text = await llmReply(t);
    const bucket = ({refuse:'refuse', doubt:'doubt', identity:'identity', price:'price', how:'how', consent:'consent', smalltalk:'smalltalk'})[intent];
    if (text) state.engineCount.llm++; else { text = pick(bucket); state.engineCount.local++; }
    await peerStream(text);

    if (finalRound){
      await wait(600);
      settle(engaged ? '对方完成收网诱导（剧本终点）' : (intent==='refuse' ? '你识破并拒绝了对方' : '对话结束'));
      return;
    }
    if (intent==='refuse' || engaged){ state.inRound=0; await advanceNow(); return; }
    state.inRound++;
    if (state.inRound >= 3){                              // 停滞太久：骗手主动推进到下一阶段
      state.inRound = 0; await advanceNow();
    }
  });
}
function meSay(text){ row('me', text); }

/* ---------- 结算报告 ---------- */
function settle(reason){
  state.lastReason = reason;
  if (state.done) return; state.done = true; hideTyping();
  $('chatView').classList.remove('on');
  const R = $('report'); R.classList.add('on');
  const score = state.score;
  const vCls = score>=80?'v-good':score>=50?'v-mid':'v-bad';
  const verdict = score>=80 ? '免疫力良好<br>继续保持' : score>=50 ? '存在明显失守点<br>建议再练一次' : '高易感<br>请务必看完逐轮复盘';
  const dedList = Object.entries(state.dedByElem).sort((a,b)=>b[1]-a[1]);
  const tops = dedList.slice(0,3).map(([e,d])=>'<span class="tag-i">'+SCRIPT.element_codes[e].name+'（−'+d+'）</span>').join('');
  const rawDed = dedList.reduce((a,[,d])=>a+d,0);
  const formula = dedList.length
    ? '100 − ' + dedList.map(([e,d])=>'<span class="neg">'+SCRIPT.element_codes[e].name+' '+d+'</span>').join(' − ') + ' = <b>'+score+'</b>' + (100-rawDed < 0 ? ' <span class="disc">（扣分合计超 100，按下限 0 计）</span>' : '')
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
    + '<div class="rp-meta">剧本 '+SCRIPT.meta.script_id+' · '+SCRIPT.meta.strain+' ｜ '+seen+' · '+reason+'<br>用时 '+dur+' ｜ '+now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0')+' '+fmtTime(now) +' · '+(state.replayed ? '样本回放 · 录制于 '+state.replayed : '样机（机制验证）')+'</div></div>'
    + '<div class="card rp-score"><div class="score-row"><span class="score-n">'+score+'</span><span class="score-d">/100</span>'
    + '<span class="score-verdict '+vCls+'">'+verdict+'</span></div>'
    + '<div class="band"><i style="width:'+score+'%"></i><u style="left:50%"></u><u style="left:80%"></u></div>'
    + '<div class="band-l"><span>高易感</span><span>有失守</span><span>良好</span></div>'
    + '<div class="formula">'+formula+'</div></div>'
    + '<div class="card"><h2>你最易失守的话术</h2><div class="tags">'+(tops||'<span class="tag-i tag-ok">本局未失守</span>')+'</div>'
    + '<p class="disc">样机阶段用固定演示权重（此处如实标注）；正式版权重 = 该话术要素在 80–100 篇公开判决书中的出现频率 × 致损关键度（2人独立评级），权重表全文公开。</p></div>'
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
    + '<button id="exportBtn" class="ghost-btn">⬇ 导出本局为回放样本（replay.js）</button>'
    + '<p class="engine-note">本局对方台词来源：大模型生成 '+state.engineCount.llm+' 条 · 本机规则引擎 '+state.engineCount.local+' 条'
    + (state.engineCount.fail ? '<br><span class="warn">另有 '+state.engineCount.fail+' 次大模型调用未成功，已自动改用本机引擎（最近原因：'+esc(state.llmErr)+'）——降级如实计数，不伪装为智能生成</span>' : '')
    + (state.replayed ? '<br><b>本页为录制样本的回放</b>（引擎 '+(REPLAY_DATA && REPLAY_DATA.llmModel ? REPLAY_DATA.llmModel : '—')+'，录制于 '+state.replayed+'），非本设备实时生成' : '')
    + '<br>推进 · 暗记 · 打分 · 结论 = 本地确定性代码 ｜ 全程对话去标识，仅用于反诈教育研究</p>'
    + '<div class="scope">关于这个样机 · <b>'+SCRIPT.meta.script_id+'</b><br>'
    + '本页验证的是<b>机制</b>：沉浸式暴露演练 + 静默行为暗记 + 可解释评分，不是最终产品的完成度。'
    + '当前内置 1 个菌株（'+SCRIPT.meta.strain+'·5 轮 '+SCRIPT.rounds.reduce((s,r)=>s+Object.values(r.lines).reduce((a,b)=>a+b.length,0),0)+' 条台词），接地语料 33 条（=附件1）；'
    + '扣分为样机固定演示权重。剧本库 v1（≥40 条·6 大类）、判决书频率加权权重表、对照实验与群体热力图见申报表技术路线与里程碑。</div>';
  $('againBtn').onclick = ()=>location.reload();
  $('exportBtn').onclick = exportReplay;
  $('quitAll').onclick = ()=>{ R.classList.remove('on'); R.innerHTML=''; $('consent').classList.add('on'); resetAll(); };
  R.scrollTop = 0;
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function resetAll(){
  Object.assign(state,{round:0,inRound:0,score:100,seenRound:null,rows:[],dedByElem:{},used:{},history:[],
    lastPeerText:'',lastUserAt:0,lastTimeAt:0,t0:0,engineCount:{llm:0,local:0,fail:0},transcript:[],replayed:null,lastReason:'',done:false});
  chat.innerHTML='';
}

/* ---------- 视图切换与事件 ---------- */
function refreshEngineLine(){
  const on = !!LLM.key;
  const t = state.lastTest;
  $('engineDot').className = 'dot' + (on && t && t.ok ? ' on' : '');
  $('engineText').textContent = on
    ? (t && t.ok ? '生成引擎：大模型已连通 · ' + (LLM.model||'custom')
       : t ? '生成引擎：Key 已填但未连通（原因见接入面板）' : '生成引擎：Key 已填待检测 · 未连通时自动改用本机引擎')
    : '生成引擎：本机规则引擎（剧本约束）';
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
$('aboutItem').onclick = ()=>{ $('menu').classList.remove('on'); enqueue(async()=>{ await peerBubble('（关于话苗）这是「话苗」AI 骗术对抗演练样机：对方台词由剧本引擎即兴生成（本机规则引擎，或已接入的大模型），推进与打分是本地确定性代码；结束后可查看防骗免疫力报告。'); }); };
$('backBtn').onclick = ()=>{ if(!state.done) $('exitDlg').classList.add('on'); };
$('exitStay').onclick = ()=>{ $('exitDlg').classList.remove('on'); input.focus({preventScroll:true}); };
$('exitEnd').onclick = ()=>{ $('exitDlg').classList.remove('on'); settle('你主动结束并退出'); };
$('llmCfgBtn').onclick = ()=>{ $('llmBase').value=LLM.base; $('llmModel').value=LLM.model; $('llmKey').value=LLM.key; $('llmSheet').classList.add('on'); keyHint(); };
$('llmSave').onclick = async ()=>{
  syncLlmFromForm(false);
  /* 模型名不再写死猜测（厂商改名后猜错就是 400，然后静默降级成罐头台词）；
   * 留空时由 testConnection 去查 /models 选用。 */
  if(!LLM.key){ LLM.base=''; LLM.model=''; state.lastTest=null; }
  localStorage.setItem('hm_llm', JSON.stringify(LLM));
  refreshEngineLine();
  if (LLM.key) await testConnection(); else $('llmSheet').classList.remove('on');
};
$('llmTest').onclick = testConnection;
$('llmKey').addEventListener('input', keyHint);
/* 拉取该 Key 实际可用的模型名，填进下拉候选，避免手打错 */
$('llmModels').onclick = async ()=>{
  syncLlmFromForm(false);
  const box = $('llmModelsHint'); if (box) box.textContent = '正在拉取…';
  const list = await fetchModels();
  if (!list || !list.length) { if (box) box.textContent = '该接口不支持 /models 列表，请手填模型名'; return; }
  const dl = $('modelOptions'); if (dl) dl.innerHTML = list.map(id => '<option value="' + id + '"></option>').join('');
  if (box) box.textContent = '可用 ' + list.length + ' 个：' + list.slice(0, 6).join(' · ') + (list.length > 6 ? ' …' : '');
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
    if (b.dataset.k !== '转账'){ toast('样机版只内置「转账」一项交互，其余入口见申报书技术方案'); return; }
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
    else { state.inRound = 0; await advanceNow(); }
  });
}

/* ---------- 回放样本：在已接入大模型的设备上导出，任何访客打开线上版即可播放 ----------
 * 动机：前端不内置密钥（红线），所以访客打开线上版只能走本机规则引擎。
 * 用一段真实对局的录制样本补足"评委点开就能看到智能"，且页面上如实标注是回放，不破红线。 */
function exportReplay(){
  const D = { kind:'hm-replay', v:1, recorded_at: new Date().toISOString().slice(0,16).replace('T',' '),
    script_id: SCRIPT.meta.script_id, strain: SCRIPT.meta.strain,
    meta: { contact_name: SCRIPT.meta.contact_name },
    transcript: state.transcript,
    rows: state.rows.map(x => ({ round:x.round, stage:x.stage, peer:x.peer, mine:x.mine, intent:x.intent, verdict:x.verdict, notes:x.notes, ded:x.ded })),
    score: state.score, ded: state.dedByElem, seenRound: state.seenRound, reason: state.lastReason,
    engine: state.engineCount, dur: Math.max(1, Math.round((Date.now()-state.t0)/1000)),
    llmModel: LLM.model || '', corpus: (typeof CORPUS !== 'undefined' ? CORPUS.length : 0) };
  const txt = '/* 话苗 · 真实对局回放样本 —— 由样机「导出本局」生成，请勿手改（改了就不可信了） */' + '\n'
    + 'const REPLAY_DATA = ' + JSON.stringify(D, null, 1) + ';\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type:'text/javascript' }));
  a.download = 'replay.js'; a.click();
  toast('已导出 replay.js —— 放回本目录并重新部署，线上即可播放');
}

async function playReplay(){
  const D = (typeof REPLAY_DATA === 'undefined' ? null : REPLAY_DATA);
  if (!D || !D.transcript || !D.transcript.length) { toast('尚未放入 replay.js'); return; }
  $('consent').classList.remove('on'); $('chatView').classList.add('on');
  $('contactName').textContent = (D.meta && D.meta.contact_name ? D.meta.contact_name.split('｜')[0] : PEER);
  chat.innerHTML = ''; state.t0 = Date.now(); timeDiv();
  for (const m of D.transcript) {
    if (m.s === 'me') { await wait(650); row('me', m.t); state.lastUserAt = Date.now(); continue; }
    if (m.img) { await peerImage(m.img, ''); continue; }
    await peerBubble(m.t);
  }
  await wait(900);
  /* 报告直接采用录制时的结算结果，不在本机重算，避免"回放出来的分数"与当时不一致 */
  state.score = D.score; state.dedByElem = D.ded || {}; state.seenRound = D.seenRound;
  state.rows = (D.rows || []).map(x => Object.assign({}, x,
    { defense: (SCRIPT.rounds[x.round-1] || {}).defense || { break:'—', correct:'—' } }));
  state.engineCount = D.engine || state.engineCount;
  state.replayed = D.recorded_at || '样本';
  state.t0 = Date.now() - (D.dur || 0) * 1000;
  settle((D.reason || '对局结束') + '（样本回放）');
}

/* 有样本才露出入口，没有就完全不出现（不放空壳按钮） */
if (typeof REPLAY_DATA !== 'undefined' && REPLAY_DATA && REPLAY_DATA.transcript && REPLAY_DATA.transcript.length) {
  $('replayBtn').hidden = false;
  $('replayBtn').onclick = playReplay;
}
