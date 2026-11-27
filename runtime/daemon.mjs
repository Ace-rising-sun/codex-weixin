import { createServer } from 'node:http';
import { chmod, mkdir, rm, open } from 'node:fs/promises';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { listHistory } from './history.mjs';
import { prepareInput, prepareOutput, sendOutput, newMediaDirectory, deliveryInstructions } from './media-flow.mjs';
import { disposeAudio } from './audio-video.mjs';
import { Codex } from './codex.mjs';
import { home, socket, read, save, defaults, validateSettings, isWindows, controlKey } from './store.mjs';
import { Weixin, incoming, trustedOrigin } from './weixin.mjs';

process.umask(0o077);
await mkdir(home, { recursive: true, mode: 0o700 });
const storedSettings = await read('settings', {});
let settings = { ...defaults, ...storedSettings };
delete settings.voiceDelivery;
let account = await read('account', null);
let state = await read('state', { cursor: '', inbox: [], seen: [], history: [], thread: null });
// A crash may have happened after a tool ran. Require an explicit new request for interrupted work.
for (const job of state.inbox) {
  if (job.status === 'running') job.status = 'interrupted';
  if (job.receipt === 'sending') job.receipt = 'unknown';
  if (job.delivery === 'sending' || (job.result && !job.delivery)) job.delivery = 'unknown';
  for (const output of job.outputs || []) if (output.delivery === 'sending') output.delivery = 'unknown';
}
let writing = Promise.resolve();
function persist() { const snapshot = structuredClone(state); writing = writing.then(() => save('state', snapshot)); return writing; }
let client = new Weixin(account || {});
let session = null;
let polling = null;
let worker = false;
let current = null;
let app = null;
let loadedThread = null;
let connected = false;
let lastError = '';
let closing = false;
let mutation = Promise.resolve();
const receipts = new Map();
const diagnostics = { received: 0, duplicates: 0, ignored: 0, missingContext: 0, invalidId: 0, lastPollAt: null, lastReceivedAt: null };
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
function log(message) { console.error(new Date().toISOString(), message); }
function safeError(error) { return error.mediaFailure ? error.message : error.writerBusy ? '该 Codex 会话正由桌面端占用，请释放后重发，或发送 /new 开始新会话。' : error.code ? `微信接口错误 ${error.code}` : error.message?.startsWith('Codex') ? error.message : '操作失败，请在设置里查看连接状态。'; }
async function deliver(job, text, options) { await client.send(job.sender, state.replyContext || job.context, text, options); }
function notify(job, text) {
  // Receipt I/O must not hold the receive/mutation lane or delay model execution.
  const pending = deliver(job, text, { timeout: 8000 }).then(() => {
    job.receipt = 'sent';
  }, error => {
    job.receipt = 'unknown';
    lastError = '接收回执投递未确认，任务仍会继续；可在插件任务记录中查看。';
    log('接收回执：' + safeError(error));
  }).then(persist).catch(() => {
    lastError = '本机状态保存失败，消息处理已暂停。'; polling?.abort(); log(lastError);
  }).finally(() => { receipts.delete(job.id); });
  receipts.set(job.id, pending);
}
function busy() { return worker || state.inbox.some(job => job.status === 'pending'); }
function complete(status) { if (!current || current.settled) return; current.settled = true; clearTimeout(current.timer); clearTimeout(current.approval?.timer); current.resolve(status); }
function decline(pending) {
  if (pending.method === 'item/permissions/requestApproval') app.respond(pending.id, { permissions: {}, scope: 'turn' });
  else app.respond(pending.id, { decision: 'decline' });
}
function events(event) {
  const { id, method, params = {} } = event;
  const run = current;
  if (id !== undefined) {
    if (!run || params.threadId !== run.threadId || (params.turnId && run.turnId && params.turnId !== run.turnId) || run.stopRequested || !approvalMethods.has(method) || run.approval) {
      if (approvalMethods.has(method)) decline({ id, method });
      else if (method === 'item/tool/requestUserInput') app.respond(id, { answers: {} });
      else app.reject(id);
      return;
    }
    const pending = { id, method, permissions: params.permissions, code: String(randomInt(100000, 1000000)) };
    run.approval = pending;
    pending.timer = setTimeout(() => { if (run.approval === pending) { decline(pending); run.approval = null; } }, 120000);
    const detail = String(params.command || params.reason || 'Codex 请求一次权限').slice(0, 700);
    void deliver(run.job, `任务等待批准\n${detail}\n\n回复 /approve ${pending.code} 或 /reject ${pending.code}，两分钟内有效。`).catch(() => { if (run.approval === pending) { clearTimeout(pending.timer); decline(pending); run.approval = null; } });
    return;
  }
  if (!run || params.threadId !== run.threadId) return;
  if (method === 'turn/started') started(params.turn.id);
  if (run.turnId && params.turnId && run.turnId !== params.turnId) return;
  if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') run.answers.set(params.item.id || 'final', params.item.text || '');
  if (method === 'turn/completed' && (!run.turnId || params.turn.id === run.turnId)) complete(params.turn.status);
}
function started(id) {
  const run = current;
  if (!run || run.turnId || run.settled) return;
  run.turnId = id;
  if (run.settings.timeoutMinutes) run.timer = setTimeout(() => void interrupt('达到执行时限，已请求停止。'), run.settings.timeoutMinutes * 60000);
  if (run.stopRequested) void interrupt();
}
async function interrupt(reason = '已请求停止当前任务。') {
  if (!current) return '当前没有执行中的任务。';
  current.stopRequested = true;
  current.controller.abort(new Error('任务已停止'));
  if (!current.submitting && !current.turnId) complete('interrupted');
  if (current.approval) { const pending = current.approval; clearTimeout(pending.timer); current.approval = null; decline(pending); }
  if (current.turnId) await app.request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId });
  return reason;
}
async function ensureApp() {
  if (!app) {
    const instance = new Codex({ executable: process.env.CODEX_WEIXIN_CODEX, directory: settings.workspace, onEvent: events, onExit() { if (app === instance) { complete('failed'); app = null; loadedThread = null; } } });
    app = instance;
  }
  await app.ready;
  return app;
}
async function execute(job) {
  const selected = state.history.find(entry => entry.id === state.thread);
  const snapshot = { ...settings, workspace: selected?.workspace || settings.workspace };
  const done = Promise.withResolvers();
  const run = { job, settings: snapshot, resolve: done.resolve, answers: new Map(), settled: false, controller: new AbortController() };
  current = run;
  try {
    job.mediaDirectory ||= newMediaDirectory();
    await persist();
    const input = await prepareInput(job, snapshot, client, run.controller.signal);
    await persist();
    run.controller.signal.throwIfAborted();
    const codex = await ensureApp();
    if (state.thread && loadedThread !== state.thread) {
      await codex.request('thread/resume', { threadId: state.thread, cwd: snapshot.workspace, model: snapshot.model, sandbox: snapshot.sandbox, approvalPolicy: 'on-request', excludeTurns: true });
      loadedThread = state.thread;
    }
    if (!state.thread) {
      const result = await codex.request('thread/start', { cwd: snapshot.workspace, model: snapshot.model, sandbox: snapshot.sandbox, approvalPolicy: 'on-request', serviceName: 'codex-weixin' });
      state.thread = result.thread.id;
      state.history.unshift({ id: state.thread, title: (job.text || '微信媒体任务').slice(0, 80), createdAt: Date.now(), workspace: snapshot.workspace });
      state.history = state.history.slice(0, 200); loadedThread = state.thread; await persist();
    }
    run.controller.signal.throwIfAborted();
    job.threadId = state.thread;
    const entry = state.history.find(item => item.id === state.thread);
    if (entry) {
      entry.updatedAt = Date.now();
      if (!entry.title || entry.title === '微信媒体任务') entry.title = (job.text || job.attachments?.find(item => item.transcript)?.transcript || '微信媒体任务').slice(0, 80);
    }
    await persist();
    run.threadId = state.thread;
    run.submitting = true;
    const submit = codex.request('turn/start', { threadId: run.threadId, model: snapshot.model, effort: snapshot.effort, input, clientUserMessageId: job.id,
      additionalContext: { 'weixin-channel': { kind: 'application', value: `你通过微信与用户交互，最终回答将送回微信。保持适合手机阅读的篇幅。回复风格仅影响表达，任务和安全要求照常。\n${snapshot.persona}\n${deliveryInstructions}` } } }, 0).then(result => started(result.turn.id));
    await Promise.race([submit, done.promise]);
    const status = await done.promise;
    if (status !== 'completed') return { status, text: status === 'interrupted' ? '本轮任务已停止。' : 'Codex 执行失败，请查看本机任务记录。' };
    await receipts.get(job.id);
    const answer = [...run.answers.values()].filter(Boolean).join('\n\n');
    const delivery = await prepareOutput(answer || '任务已完成。', job, snapshot, run.controller.signal);
    job.outputs = delivery.outputs;
    job.mediaErrors = [...(job.inputErrors || []), ...delivery.errors];
    await persist();
    for (const output of job.outputs) {
      try {
        job.context = state.replyContext || job.context;
        await sendOutput(client, job, output, snapshot.maxMediaMb * 1024 * 1024, run.controller.signal, async () => { output.delivery = 'sending'; await persist(); });
        output.delivery = 'sent';
      } catch (error) {
        output.delivery = output.delivery === 'sending' ? 'unknown' : 'failed';
        output.error = safeError(error);
        job.mediaErrors.push(output.delivery === 'unknown' ? '附件已提交但投递未确认，请在手机核对后再决定是否重发。' : output.error);
      }
      await persist();
      if (run.stopRequested) break;
    }
    const notes = job.mediaErrors.map(message => `附件提示：${message}`).join('\n');
    return { status: run.stopRequested ? 'interrupted' : 'completed', text: [delivery.text, notes].filter(Boolean).join('\n\n') || '附件已提交发送。' };
  } catch (error) {
    if (run.stopRequested) return { status: 'interrupted', text: '本轮任务已停止。' };
    throw error;
  } finally {
    clearTimeout(run.timer);
    if (run.approval) { clearTimeout(run.approval.timer); try { decline(run.approval); } catch {} }
    current = null;
  }
}
async function drain() {
  if (worker || closing) return;
  worker = true;
  try {
    while (account && !closing) {
      const job = state.inbox.find(item => item.status === 'pending');
      if (!job) break;
      job.status = 'running'; job.startedAt = Date.now(); await persist();
      let answer;
      try { const outcome = await execute(job); answer = outcome.text; job.status = outcome.status; }
      catch (error) { answer = safeError(error); job.status = 'failed'; lastError = answer; log(answer); }
      job.finishedAt = Date.now(); job.result = answer;
      const entry = state.history.find(item => item.id === job.threadId);
      if (entry) entry.updatedAt = job.finishedAt;
      job.delivery = 'sending';
      await persist();
      await receipts.get(job.id);
      try { await deliver(job, answer); job.delivery = job.mediaErrors?.length ? 'partial' : 'sent'; job.deliveredAt = Date.now(); }
      catch (error) { job.delivery = 'unknown'; lastError = '结果投递未确认，请在插件任务记录中查看。'; log(safeError(error)); }
      await persist();
    }
  } catch (error) { lastError = '本机状态保存失败，消息处理已暂停。'; log(lastError); polling?.abort(); }
  finally { worker = false; }
}
async function controlMessage(job) {
  const text = job.text.trim();
  if (text === '/help') return '直接发送文字、图片、语音、视频或文件即可派任务。\n/status 查看连接与任务\n/stop 停止当前任务\n/new 开始新会话\n/list [页码] 查看会话\n/use 序号或会话ID 切换\n/history 同 /list\n/approve 验证码 批准权限\n/reject 验证码 拒绝权限';
  if (text === '/status' || text === '/ping') return `微信已连接\n当前会话 ${state.history.find(entry => entry.id === state.thread)?.title || '新会话（待首次任务）'}\n模型 ${settings.model}\n正在执行 ${current ? '是' : '否'}\n回传结果 ${worker && !current ? '是' : '否'}\n排队 ${state.inbox.filter(x => x.status === 'pending').length}\n时限 ${settings.timeoutMinutes || '不限'}${settings.timeoutMinutes ? ' 分钟' : ''}`;
  if (text === '/stop') return interrupt();
  if (text === '/new') {
    if (busy()) return '请先等待执行和排队任务结束（包含结果回传），再开始新会话。/stop 只停止当前任务。';
    if (loadedThread && app) { await app.request('thread/unsubscribe', { threadId: loadedThread }); loadedThread = null; }
    state.thread = null; await persist(); return '已开始新会话，下一条任务使用新的上下文。';
  }
  const list = text.match(/^\/(?:list|history)(?:\s+(.*))?$/);
  if (list) {
    const page = list[1] === undefined ? 1 : Number(list[1]);
    const history = listHistory(state, current?.threadId).history;
    const pages = Math.max(1, Math.ceil(history.length / 10));
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) return `页码无效，请发送 /list 1 到 /list ${pages}。`;
    if (!history.length) return '暂无历史。直接发送任务会创建会话。';
    // Pin displayed numbers until the next list request; activity may change meanwhile.
    state.sessionChoices = history.map(entry => entry.id);
    const rows = history.slice((page - 1) * 10, page * 10).map((entry, index) => `${(page - 1) * 10 + index + 1}. ${entry.current ? '【当前】' : ''}${entry.title}\nID ${entry.id}\ncodex://threads/${entry.id}`);
    return `会话列表 ${page}/${pages}\n\n${rows.join('\n\n')}\n\n发送 /use 序号 切换，也支持完整 ID 或唯一 ID 前缀（至少 6 位）。`;
  }
  const use = text.match(/^\/use(?:\s+(.*))?$/);
  if (use) {
    if (busy()) return '请先等待执行和排队任务结束（包含结果回传），再切换会话。/stop 只停止当前任务。';
    const selector = use[1]?.trim();
    if (!selector) return '用法：/list 查看会话，再发送 /use 2；也支持完整会话 ID。';
    let candidates = state.history.filter(entry => entry.id === selector);
    if (!candidates.length && /^\d+$/.test(selector)) candidates = state.history.filter(entry => entry.id === state.sessionChoices?.[Number(selector) - 1]);
    if (!candidates.length && selector.length >= 6) candidates = state.history.filter(entry => entry.id.startsWith(selector));
    if (candidates.length !== 1) return candidates.length ? 'ID 前缀匹配多个会话，请使用完整 ID。' : '未找到该会话，请发送 /list 后重新选择。';
    const target = candidates[0];
    if (target.id === state.thread) return `已在当前会话：${target.title}`;
    const workspace = target.workspace || settings.workspace;
    try { await validateSettings({ ...settings, workspace }); }
    catch { return '该会话的工作目录不可用，请恢复目录后再切换。'; }
    const codex = await ensureApp();
    if (loadedThread) { await codex.request('thread/unsubscribe', { threadId: loadedThread }); loadedThread = null; }
    // Keep the old selection if resume fails (deleted thread or another active writer).
    await codex.request('thread/resume', { threadId: target.id, cwd: workspace, model: settings.model, sandbox: settings.sandbox, approvalPolicy: 'on-request', excludeTurns: true });
    loadedThread = target.id; state.thread = target.id;
    return `已切换到：${target.title}\n工作目录 ${workspace}\n后续消息将继续此会话。`;
  }
  const match = text.match(/^\/(approve|reject)\s+(\d{6})$/);
  if (match) {
    const pending = current?.approval;
    if (!pending || pending.code !== match[2]) return '批准码无效或已过期。';
    clearTimeout(pending.timer); current.approval = null;
    const accept = match[1] === 'approve';
    app.respond(pending.id, pending.method === 'item/permissions/requestApproval' ? { permissions: accept ? pending.permissions || {} : {}, scope: 'turn' } : { decision: accept ? 'accept' : 'decline' });
    return accept ? '已批准本次请求。' : '已拒绝本次请求。';
  }
  if (/^\/[a-z]+(?:\s|$)/i.test(text)) return '未知命令或格式不正确，请发送 /help。';
  return null;
}
async function receive(raw) {
  const job = incoming(raw);
  if (!job || job.sender !== account?.owner) { diagnostics.ignored++; return; }
  diagnostics.received++; diagnostics.lastReceivedAt = Date.now();
  if (!job.id) { diagnostics.invalidId++; lastError = '入站消息缺少编号，已跳过，请重新发送。'; log(lastError); return; }
  if (state.seen.includes(job.id)) { diagnostics.duplicates++; return; }
  if (job.context) state.replyContext = job.context;
  job.context ||= state.replyContext;
  if (!job.context) { diagnostics.missingContext++; lastError = '入站消息缺少回复凭证，已跳过，请重新发送。'; log(lastError); return; }
  let result = null;
  if (!job.hasMedia) {
    try { result = await controlMessage(job); }
    catch (error) { result = safeError(error); lastError = result; log(result); }
  }
  if (result === null && !job.text.trim() && !job.media?.length) result = '未能识别消息内容，请发送文字、图片、语音、视频或文件。';
  if (result === null && (job.media?.length || 0) > 4) result = '单条消息最多处理 4 个附件，请拆分发送。';
  if (result === null && state.inbox.filter(x => ['pending', 'running'].includes(x.status)).length >= 6) result = '任务队列已满，请稍后发送。';
  if (result === null) {
    state.inbox = state.inbox.filter(x => ['pending', 'running', 'interrupted'].includes(x.status) || x.finishedAt > Date.now() - 7 * 86400000).slice(-199);
    Object.assign(job, { status: 'pending', receipt: 'sending', createdAt: Date.now() });
    state.inbox.push(job);
  }
  state.seen.push(job.id); state.seen = state.seen.slice(-10000);
  // Admission and deduplication are durable before any reply or task execution.
  await persist();
  notify(job, result ?? (worker ? '已接收，正在本会话中排队。' : '已接收，Codex 正在处理。'));
  if (result === null) void drain();
}
function connect() {
  polling?.abort();
  if (!account || closing) return;
  const controller = new AbortController(); polling = controller;
  void (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const batch = await client.updates(state.cursor, controller.signal);
        if (controller.signal.aborted) break;
        connected = true; failures = 0; diagnostics.lastPollAt = Date.now();
        for (const message of batch.msgs || []) {
          if (controller.signal.aborted) break;
          const pending = mutation.then(() => controller.signal.aborted ? undefined : receive(message));
          mutation = pending.catch(() => {});
          await pending;
        }
        if (controller.signal.aborted) break;
        if (batch.get_updates_buf) { state.cursor = batch.get_updates_buf; await persist(); }
        await delay(300, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) break;
        connected = false;
        lastError = safeError(error); log(lastError);
        if (error.code === -14 || error.code === 401 || error.code === 403) { lastError = '微信授权失效或被限制，请在设置里重新连接。'; break; }
        await delay(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)), undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  })().catch(() => { if (!controller.signal.aborted) { connected = false; lastError = '消息接收已停止，请检查本机日志。'; log(lastError); } });
  void drain();
}
async function login() {
  if (account) throw new Error('已有微信绑定，请先断开当前微信再绑定');
  if (current || worker || state.inbox.some(x => x.status === 'pending')) throw new Error('请等待任务结束后再绑定微信');
  if (session?.active) throw new Error('已有扫码登录进行中，请先取消或等待结束');
  const wx = new Weixin();
  const qr = await wx.qr();
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信未返回可用二维码');
  const login = { active: true, status: 'wait', image: await QRCode.toDataURL(qr.qrcode_img_content, { width: 280, margin: 2 }), controller: new AbortController(), pin: '' };
  session = login;
  void (async () => {
    const deadline = Date.now() + 300000;
    let origin = 'https://ilinkai.weixin.qq.com';
    try {
      while (login.active && Date.now() < deadline) {
        if (login.status.includes('need_verifycode') && !login.pin) { await delay(500, undefined, { signal: login.controller.signal }); continue; }
        const pin = login.pin; login.pin = '';
        let result;
        try { result = await wx.pollLogin(qr.qrcode, pin, origin, login.controller.signal); }
        catch (error) { if (login.controller.signal.aborted) break; await delay(1000, undefined, { signal: login.controller.signal }); continue; }
        login.status = result.status || 'wait';
        if (result.status === 'scaned_but_redirect') { origin = trustedOrigin('https://' + result.redirect_host); }
        if (result.status === 'confirmed') {
          if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new Error('微信授权响应缺少必要信息');
          const next = { token: result.bot_token, bot: result.ilink_bot_id, owner: result.ilink_user_id, baseurl: trustedOrigin(result.baseurl || 'https://ilinkai.weixin.qq.com') };
          polling?.abort();
          if (account?.owner !== next.owner || account?.bot !== next.bot) { state = { cursor: '', inbox: [], seen: [], history: state.history, thread: null }; await persist(); }
          await save('account', next); account = next; client = new Weixin(account); login.active = false; login.image = null; connect(); return;
        }
        if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) break;
        await delay(500, undefined, { signal: login.controller.signal });
      }
      login.active = false; login.image = null;
      if (login.status === 'wait' || login.status === 'scaned') login.status = 'expired';
    } catch (error) { login.active = false; login.image = null; login.status = 'failed'; lastError = safeError(error); }
  })();
}
function publicStatus() {
  return { connected, bound: Boolean(account), account: account ? { userId: account.owner, botId: account.bot } : null, lastError, login: session ? { active: session.active, status: session.status, image: session.image } : null,
    version: '0.5.0', busy: busy(), diagnostics: { ...diagnostics }, activeThread: state.thread, settings, current: current ? { title: current.job.text.slice(0, 80), startedAt: current.job.startedAt, approval: Boolean(current.approval) } : null,
    tasks: state.inbox.slice(-30).reverse().map(({ text, status, receipt, delivery, result, createdAt, startedAt, finishedAt, deliveredAt, attachments, outputs }) => ({ attachments: (attachments || []).map(({kind, name}) => ({kind, name})), outputs: (outputs || []).map(({kind, name, delivery}) => ({kind, name, delivery})), title: (text || '微信媒体任务').slice(0, 120), status, receipt, delivery, result, createdAt, startedAt, finishedAt, deliveredAt })), history: state.history };
}
async function action(name, body) {
  if (name === 'status') return publicStatus();
  if (name === 'history') return listHistory(state, current?.threadId);
  if (name === 'login') { await login(); return publicStatus(); }
  if (name === 'pin') { if (!session?.active || !session.status.includes('need_verifycode') || !/^\d{4,12}$/.test(body.pin)) throw new Error('请输入手机显示的数字验证码'); session.pin = body.pin; return { ok: true }; }
  if (name === 'cancelLogin') { session?.controller.abort(); if (session) { session.active = false; session.image = null; session.status = 'cancelled'; } return { ok: true }; }
  if (name === 'save') {
    if (current || worker || state.inbox.some(x => x.status === 'pending')) throw new Error('请等待任务结束后保存设置');
    const next = await validateSettings(body);
    await save('settings', next);
    if (settings.workspace !== next.workspace || settings.sandbox !== next.sandbox) { app?.close(); app = null; loadedThread = null; state.thread = null; await persist(); }
    settings = next; return publicStatus();
  }
  if (name === 'stop') return { message: await interrupt() };
  if (name === 'reconnect') { connected = false; lastError = ''; connect(); return publicStatus(); }
  if (name === 'logout') {
    if (worker || current || state.inbox.some(x => x.status === 'pending')) throw new Error('请先等待任务结束再断开微信');
    session?.controller.abort(); if (session) { session.active = false; session.image = null; }
    polling?.abort(); connected = false;
    await rm(home + '/account.json', { force: true }); account = null;
    state.cursor = ''; state.thread = null; state.inbox = []; state.seen = []; delete state.replyContext; delete state.sessionChoices; await persist();
    app?.close(); app = null; loadedThread = null; return publicStatus();
  }
  throw new Error('不支持的操作');
}
const key = await controlKey();
const authorization = key ? Buffer.from('Bearer ' + key) : null;
const server = createServer(async (request, response) => {
  try {
    if (authorization) {
      const provided = Buffer.from(request.headers.authorization || '');
      if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) { response.writeHead(401); return response.end(); }
    }
    if (request.method !== 'POST') { response.writeHead(405); return response.end(); }
    let buffer = ''; for await (const chunk of request) { buffer += chunk; if (buffer.length > 16000) throw new Error('请求过大'); }
    const body = JSON.parse(buffer || '{}');
    const name = request.url.slice(1);
    let result;
    if (name === 'status' || name === 'history' || name === 'stop' || name === 'pin') result = await action(name, body);
    else { const pending = mutation.then(() => action(name, body)); mutation = pending.catch(() => {}); result = await pending; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: /^[\p{Script=Han}]/u.test(error.message) ? error.message : '操作失败' })); }
});
// A second daemon must never remove or replace the active process's socket.
const lock = await open(home + '/daemon.lock', 'wx', 0o600).catch(async error => {
  if (error.code !== 'EEXIST') throw error;
  const pid = Number(await (await import('node:fs/promises')).readFile(home + '/daemon.lock', 'utf8'));
  try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { await rm(home + '/daemon.lock'); return open(home + '/daemon.lock', 'wx', 0o600); } throw probe; }
  throw new Error('微信后台已在运行');
});
await lock.writeFile(String(process.pid));
if (Object.hasOwn(storedSettings, 'voiceDelivery')) {
  const { voiceDelivery, ...remaining } = storedSettings;
  await save('settings', remaining);
}
await persist();
if (!isWindows) await rm(socket, { force: true });
server.listen(socket, async () => { if (!isWindows) await chmod(socket, 0o600); log('微信后台已就绪'); connect(); });
async function shutdown() {
  if (closing) return; closing = true;
  polling?.abort(); session?.controller.abort(); current?.controller.abort(); complete('interrupted'); disposeAudio(); app?.close();
  server.close(); await writing.catch(() => {}); if (!isWindows) await rm(socket, { force: true }); await lock.close(); await rm(home + '/daemon.lock', { force: true }); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
