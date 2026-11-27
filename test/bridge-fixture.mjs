import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, appendFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { testControl } from './support.mjs';

const daemon = fileURLToPath(new URL('../runtime/daemon.mjs', import.meta.url));
export async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wx-messaging-'));
  const messages = [];
  const incomingFile = join(home, 'messages.json');
  const sentFile = join(home, 'sent.jsonl');
  const callsFile = join(home, 'calls.jsonl');
  const releaseFile = join(home, 'release');
  await mkdir(join(home,'media'), {recursive:true});
  const artifact = join(home, 'media', 'artifact.txt'); await writeFile(artifact, 'prepared attachment');
  await Promise.all([writeFile(incomingFile, ''), writeFile(sentFile, ''), writeFile(callsFile, '')]);
  await writeFile(join(home, 'account.json'), JSON.stringify({ token: 'fixture', owner: 'owner', bot: 'bot' }));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ workspace: home, ...(options.settings || {}) }));
  if (options.state) await writeFile(join(home, 'state.json'), JSON.stringify(typeof options.state === 'function' ? await options.state(home) : options.state));
  const fake = join(home, 'codex.cjs');
  await writeFile(fake, `
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const send = message => console.log(JSON.stringify(message));
const event = (method, params) => send({ method, params });
let counter = 0, timer, finishApproval;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.id === 900 && !message.method) { if (finishApproval) finishApproval(); return; }
  appendFileSync(process.env.TEST_CALLS, JSON.stringify(message) + '\\n');
  let result = {};
  if (message.method === 'thread/start') result = { thread: { id: '10000000-0000-0000-0000-' + String(++counter).padStart(12, '0') } };
  if (message.method === 'thread/resume' && message.params.threadId.startsWith('dead')) {
    send({ id: message.id, error: { code: -32600, message: 'active writer' } }); return;
  }
  if (message.method === 'turn/start' && message.params.input[0].text === 'fail-task') { send({ id: message.id, error: { code: -32000, message: 'fixture failure' } }); return; }
  if (message.method === 'turn/start') {
    const turn = 'turn-' + message.params.clientUserMessageId;
    const threadId = message.params.threadId;
    result = { turn: { id: turn } };
    event('turn/started', { threadId, turn: { id: turn } });
    const finish = () => {
      event('item/completed', { threadId, turnId: turn, item: { id: turn + '-comment', type: 'agentMessage', phase: 'commentary', text: 'hidden progress' } });
      event('item/completed', { threadId, turnId: turn, item: { id: turn + '-a', type: 'agentMessage', text: process.env.TEST_MODEL_MEMORY_TEXT || 'first answer' } });
      event('item/completed', { threadId, turnId: turn, item: { id: turn + '-b', type: 'agentMessage', text: 'second answer' + (process.env.TEST_ATTACHMENT && message.params.input[0].text === 'attachment-task' ? '\\nWEIXIN_MEDIA: ' + JSON.stringify({ path: process.env.TEST_ARTIFACT, kind: 'file' }) : '') } });
      event('turn/completed', { threadId, turn: { id: turn, status: 'completed' } });
    };
    if (message.params.input[0].text === 'approval-task') { finishApproval = finish; send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: turn, command: 'fixture command' } }); }
    else timer = setTimeout(finish, Number(process.env.TEST_TURN_DELAY));
  }
  if (message.method === 'turn/interrupt') {
    clearTimeout(timer);
    event('turn/completed', { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted' } });
  }
  send({ id: message.id, result });
});`);
  const preload = join(home, 'network.mjs');
  const memoryModule = new URL('../runtime/memory.mjs',import.meta.url).href;
  await writeFile(preload, `
import { readFile, appendFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
if (process.env.TEST_HOLD_MEMORY) {
  const {MemoryStore}=await import(${JSON.stringify(memoryModule)});
  const serialize=MemoryStore.prototype.serialize;
  MemoryStore.prototype.serialize=function(action){return serialize.call(this,async()=>{
    await appendFile(process.env.TEST_RELEASE+'.memory','1');
    while(true){try{await access(process.env.TEST_RELEASE);break;}catch{await delay(20);}}
    return action();
  });};
}
let polls = 0, receipts = 0;
globalThis.fetch = async (url, request) => {
  if (url.includes('/c2c/backup')) {
    await appendFile(process.env.TEST_RELEASE + '.download', '1');
    if (process.env.TEST_HOLD_DOWNLOAD) while (true) { try { await access(process.env.TEST_RELEASE); break; } catch { await delay(20, undefined, { signal: request.signal }); } }
    return new Response(await readFile(process.env.TEST_RELEASE + '.backup'));
  }
  if (url.includes('/c2c/upload')) {
    await appendFile(process.env.TEST_RELEASE + '.upload', '1');
    if (process.env.TEST_HOLD_UPLOAD) while (true) { try { await access(process.env.TEST_RELEASE); break; } catch { await delay(20, undefined, { signal: request.signal }); } }
    return new Response('', { headers: { 'x-encrypted-param': 'download' } });
  }
  const body = JSON.parse(request.body);
  if (url.includes('getuploadurl')) return Response.json({ ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' });
  if (url.includes('getupdates')) {
    if (process.env.TEST_STALE_POLL && !polls++) {
      await appendFile(process.env.TEST_RELEASE + '.held', '1');
      while (true) { try { await access(process.env.TEST_RELEASE); break; } catch { await delay(20); } }
      await appendFile(process.env.TEST_RELEASE + '.returned', '1');
      return Response.json({ msgs: [{ message_type: 1, message_id: 'stale', from_user_id: 'owner', context_token: 'old-context', item_list: [{ type: 1, text_item: { text: 'must not run' } }] }], get_updates_buf: 'old-cursor' });
    }
    if (process.env.TEST_IDLE_TIMEOUT && !polls++) throw new DOMException('idle', 'TimeoutError');
    await delay(20, undefined, { signal: request.signal });
    const input = (await readFile(process.env.TEST_INCOMING, 'utf8')).split('\\n').slice(0, -1).filter(Boolean).map(JSON.parse);
    const response = { ret: 0, msgs: input.slice(Number(body.get_updates_buf || 0)), get_updates_buf: String(input.length) };
    return new Response(JSON.stringify(response).replace(/"message_id":"(\\d{17,})"/g, '"message_id":$1'));
  }
  if (url.includes('sendmessage')) {
    const text = body.msg.item_list[0]?.text_item?.text || '';
    await appendFile(process.env.TEST_SENT, JSON.stringify(body.msg) + '\\n');
    if (text.startsWith('已接收') && !receipts++ && process.env.TEST_HOLD_RECEIPT) {
      while (true) {
        try { await access(process.env.TEST_RELEASE); break; }
        catch { await delay(20, undefined, { signal: request.signal }); }
      }
      throw new Error('receipt delivery unknown');
    }
    if ((text.startsWith('任务 T') || text.startsWith('first answer')) && text.includes('first answer') && process.env.TEST_HOLD_RESULT) {
      while (true) { try { await access(process.env.TEST_RELEASE); break; } catch { await delay(20, undefined, { signal: request.signal }); } }
    }
    if ((text.startsWith('任务 T') || text.startsWith('first answer')) && text.includes('first answer') && process.env.TEST_FAIL_RESULT) throw new Error('result delivery unknown');
    return Response.json({ ret: 0 });
  }
  throw new Error('unexpected fixture endpoint');
};`);
  let child, logs = '';
  function start() { child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, daemon], {
    env: { ...process.env, CODEX_WEIXIN_HOME: home, CODEX_WEIXIN_CODEX: fake, TEST_INCOMING: incomingFile, TEST_SENT: sentFile, TEST_CALLS: callsFile, TEST_RELEASE: releaseFile,
      TEST_HOLD_MEMORY: options.holdMemory ? '1' : '', TEST_MODEL_MEMORY_TEXT: options.modelMemoryText || '', TEST_HOLD_DOWNLOAD: options.holdDownload ? '1' : '', TEST_ARTIFACT: artifact, TEST_ATTACHMENT: options.attachment ? '1' : '', TEST_HOLD_UPLOAD: options.holdUpload ? '1' : '', TEST_STALE_POLL: options.stalePoll ? '1' : '', TEST_HOLD_RECEIPT: options.holdReceipt ? '1' : '', TEST_FAIL_RESULT: options.failResult ? '1' : '', TEST_HOLD_RESULT: options.holdResult ? '1' : '', TEST_IDLE_TIMEOUT: options.idleTimeout ? '1' : '', TEST_TURN_DELAY: String(options.turnDelay || 150) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', bytes => { logs += bytes; }); }
  start();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
    await rm(home, { recursive: true, force: true });
  });
  const lines = async file => (await readFile(file, 'utf8')).split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
  const status = () => testControl(home, 'status');
  async function until(predicate) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = await status().catch(() => null);
      if (value && await predicate(value)) return value;
      await delay(25);
    }
    throw new Error('Fixture did not reach expected state: ' + logs);
  }
  await until(() => true);
  return { home, status, until, calls: () => lines(callsFile), sent: () => lines(sentFile), disk: async () => JSON.parse(await readFile(join(home, 'state.json'), 'utf8')),
    release: () => writeFile(releaseFile, ''),
    async restart(nextAccount) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; if(nextAccount) { messages.length=0; await writeFile(incomingFile,''); await writeFile(join(home,'account.json'),JSON.stringify(nextAccount)); } start(); await until(() => true); },
    async push(text, { id = 'message-' + messages.length, sender = 'owner', context = 'fixture-context', raw } = {}) {
      messages.push(raw === undefined ? { message_type: 1, message_id: id, from_user_id: sender, context_token: context, item_list: [{ type: 1, text_item: { text } }] } : raw);
      // Append complete records; replacing a file held by a reader races on Windows.
      await appendFile(incomingFile, JSON.stringify(messages.at(-1)) + '\n');
    },
    async command(text, expected) {
      const before = (await lines(sentFile)).length;
      await this.push(text);
      await until(async () => (await lines(sentFile)).slice(before).some(message => expected.test(message.item_list[0]?.text_item?.text || '')));
    },
  };
}
