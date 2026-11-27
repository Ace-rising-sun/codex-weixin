import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { testControl } from './support.mjs';

const daemon = fileURLToPath(new URL('../runtime/daemon.mjs', import.meta.url));
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wx-messaging-'));
  const messages = [];
  const incomingFile = join(home, 'messages.json');
  const sentFile = join(home, 'sent.jsonl');
  const callsFile = join(home, 'calls.jsonl');
  const releaseFile = join(home, 'release');
  await Promise.all([writeFile(incomingFile, '[]'), writeFile(sentFile, ''), writeFile(callsFile, '')]);
  await writeFile(join(home, 'account.json'), JSON.stringify({ token: 'fixture', owner: 'owner', bot: 'bot' }));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ workspace: home }));
  if (options.state) await writeFile(join(home, 'state.json'), JSON.stringify(typeof options.state === 'function' ? await options.state(home) : options.state));
  const fake = join(home, 'codex.cjs');
  await writeFile(fake, `
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const send = message => console.log(JSON.stringify(message));
const event = (method, params) => send({ method, params });
let counter = 0, timer;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  appendFileSync(process.env.TEST_CALLS, JSON.stringify(message) + '\\n');
  let result = {};
  if (message.method === 'thread/start') result = { thread: { id: '10000000-0000-0000-0000-' + String(++counter).padStart(12, '0') } };
  if (message.method === 'thread/resume' && message.params.threadId.startsWith('dead')) {
    send({ id: message.id, error: { code: -32600, message: 'active writer' } }); return;
  }
  if (message.method === 'turn/start') {
    const turn = 'turn-' + message.params.clientUserMessageId;
    const threadId = message.params.threadId;
    result = { turn: { id: turn } };
    event('turn/started', { threadId, turn: { id: turn } });
    timer = setTimeout(() => {
      event('item/completed', { threadId, turnId: turn, item: { id: turn + '-comment', type: 'agentMessage', phase: 'commentary', text: 'hidden progress' } });
      event('item/completed', { threadId, turnId: turn, item: { id: turn + '-a', type: 'agentMessage', text: 'first answer' } });
      event('item/completed', { threadId, turnId: turn, item: { id: turn + '-b', type: 'agentMessage', text: 'second answer' } });
      event('turn/completed', { threadId, turn: { id: turn, status: 'completed' } });
    }, Number(process.env.TEST_TURN_DELAY));
  }
  if (message.method === 'turn/interrupt') {
    clearTimeout(timer);
    event('turn/completed', { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted' } });
  }
  send({ id: message.id, result });
});`);
  const preload = join(home, 'network.mjs');
  await writeFile(preload, `
import { readFile, appendFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
let polls = 0, receipts = 0;
globalThis.fetch = async (url, request) => {
  const body = JSON.parse(request.body);
  if (url.includes('getupdates')) {
    if (process.env.TEST_STALE_POLL && !polls++) {
      await appendFile(process.env.TEST_RELEASE + '.held', '1');
      while (true) { try { await access(process.env.TEST_RELEASE); break; } catch { await delay(20); } }
      await appendFile(process.env.TEST_RELEASE + '.returned', '1');
      return Response.json({ msgs: [{ message_type: 1, message_id: 'stale', from_user_id: 'owner', context_token: 'old-context', item_list: [{ type: 1, text_item: { text: 'must not run' } }] }], get_updates_buf: 'old-cursor' });
    }
    if (process.env.TEST_IDLE_TIMEOUT && !polls++) throw new DOMException('idle', 'TimeoutError');
    await delay(20, undefined, { signal: request.signal });
    const input = JSON.parse(await readFile(process.env.TEST_INCOMING, 'utf8'));
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
    if (text.startsWith('first answer') && process.env.TEST_FAIL_RESULT) throw new Error('result delivery unknown');
    return Response.json({ ret: 0 });
  }
  throw new Error('unexpected fixture endpoint');
};`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, daemon], {
    env: { ...process.env, CODEX_WEIXIN_HOME: home, CODEX_WEIXIN_CODEX: fake, TEST_INCOMING: incomingFile, TEST_SENT: sentFile, TEST_CALLS: callsFile, TEST_RELEASE: releaseFile,
      TEST_STALE_POLL: options.stalePoll ? '1' : '', TEST_HOLD_RECEIPT: options.holdReceipt ? '1' : '', TEST_FAIL_RESULT: options.failResult ? '1' : '', TEST_IDLE_TIMEOUT: options.idleTimeout ? '1' : '', TEST_TURN_DELAY: String(options.turnDelay || 150) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = ''; child.stderr.on('data', bytes => { logs += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
    await rm(home, { recursive: true, force: true });
  });
  const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
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
    async push(text, { id = 'message-' + messages.length, sender = 'owner', context = 'fixture-context', raw } = {}) {
      messages.push(raw === undefined ? { message_type: 1, message_id: id, from_user_id: sender, context_token: context, item_list: [{ type: 1, text_item: { text } }] } : raw);
      const temporary = incomingFile + '.next';
      await writeFile(temporary, JSON.stringify(messages));
      await (await import('node:fs/promises')).rename(temporary, incomingFile);
    },
    async command(text, expected) {
      const before = (await lines(sentFile)).length;
      await this.push(text);
      await until(async () => (await lines(sentFile)).slice(before).some(message => expected.test(message.item_list[0]?.text_item?.text || '')));
    },
  };
}

test('uint64 tasks and commands survive duplicate delivery, idle polls and a blocked receipt', { timeout: 15000 }, async t => {
  const f = await fixture(t, { holdReceipt: true, idleTimeout: true });
  await f.push('', { raw: null });
  await f.push('foreign', { sender: 'stranger', context: 'foreign-context' });
  await f.push('first', { id: '18446744073709551610' });
  await f.until(s => s.current?.title === 'first');
  await f.push('second', { id: '18446744073709551611', context: null });
  await f.push('first replay', { id: '18446744073709551610' });
  await f.until(s => s.tasks.length === 2 && s.diagnostics.duplicates === 1);
  await f.command('/ping', /微信已连接/);
  await f.command('/new', /等待执行和排队任务结束/);
  assert.equal((await f.status()).tasks.find(job => job.title === 'first').receipt, 'sending');
  await f.release();
  const done = await f.until(s => s.tasks.length === 2 && s.tasks.every(job => job.delivery === 'sent'));
  assert.equal(done.tasks.find(job => job.title === 'first').receipt, 'unknown');
  assert.ok(done.tasks.every(job => job.result === 'first answer\n\nsecond answer'));
  assert.ok(done.tasks.every(job => job.startedAt >= job.createdAt && job.deliveredAt >= job.finishedAt));
  assert.deepEqual((await f.disk()).inbox.map(job => job.id), ['18446744073709551610', '18446744073709551611']);
  const calls = (await f.calls()).filter(call => call.method === 'turn/start');
  assert.equal(calls.length, 2);
  assert.ok((await f.sent()).every(message => message.to_user_id === 'owner' && message.context_token !== 'foreign-context'));
  await f.command('/new', /已开始新会话/);
  assert.equal((await f.status()).activeThread, null);
});

test('new-session commands with adjacent uint64 ids each reply exactly once', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.push('/new', { id: '18446744073709551610' });
  await f.push('/new', { id: '18446744073709551611' });
  await f.push('/new', { id: '18446744073709551610' });
  await f.until(async s => s.diagnostics.duplicates === 1 && (await f.sent()).length === 2);
  assert.ok((await f.sent()).every(message => /已开始新会话/.test(message.item_list[0].text_item.text)));
  assert.equal((await f.calls()).length, 0);
});

test('session list pagination, stable numbers, switching, busy guards and new contexts work together', { timeout: 15000 }, async t => {
  const histories = Array.from({ length: 12 }, (_, index) => ({ id: '20000000-0000-0000-0000-' + String(index + 1).padStart(12, '0'), title: 'session ' + (index + 1), createdAt: index + 1 }));
  const state = { cursor: '', inbox: [], seen: [], history: histories, thread: histories[11].id };
  const f = await fixture(t, { state: async home => { histories[10].workspace = join(home, 'restored'); await mkdir(histories[10].workspace); return state; }, turnDelay: 600 });
  await f.command('/list', /会话列表 1\/2/);
  await f.command('/use 2', /已切换到：session 11/);
  assert.equal((await f.status()).activeThread, histories[10].id);
  assert.equal((await f.calls()).find(call => call.method === 'thread/resume').params.cwd, histories[10].workspace);
  await f.push('continue selected');
  await f.until(s => s.current?.title === 'continue selected');
  await f.command('/use 3', /等待执行和排队任务结束/);
  await f.until(s => s.tasks[0]?.delivery === 'sent');
  assert.equal((await f.calls()).find(call => call.method === 'turn/start').params.threadId, histories[10].id);
  await f.command('/use 3', /已切换到：session 10/);
  await f.command('/use 200000', /匹配多个会话/);
  await f.command('/list 2', /会话列表 2\/2/);
  await f.command('/use 12', /已切换到：session 1/);
  await f.command('/use ' + histories[5].id, /已切换到：session 6/);
  await f.command('/list 0', /页码无效/);
  await f.command('/use 99', /未找到/);
  await f.command('/new', /已开始新会话/);
  await f.push('fresh task');
  const done = await f.until(s => s.tasks.length === 2 && s.tasks.every(job => job.delivery === 'sent'));
  assert.ok(!histories.some(entry => entry.id === done.activeThread));
});

test('failed switches keep the old selection and malformed commands do not become model tasks', { timeout: 10000 }, async t => {
  const state = { cursor: '', inbox: [], seen: [], thread: 'active-thread', history: [{ id: 'active-thread', title: 'active' }, { id: 'dead-thread', title: 'busy' }, { id: 'missing-directory', title: 'missing', workspace: join(tmpdir(), 'wx-no-such-directory') }] };
  const f = await fixture(t, { state });
  await f.command('/use dead-thread', /桌面端占用/);
  assert.equal((await f.status()).activeThread, 'active-thread');
  await f.command('/use missing-directory', /工作目录不可用/);
  await f.command('/use', /用法/);
  await f.command('/nwe', /未知命令/);
  assert.equal((await f.status()).tasks.length, 0);
  await f.push('/tmp/example.txt');
  await f.until(s => s.tasks[0]?.delivery === 'sent');
  assert.equal((await f.calls()).find(call => call.method === 'turn/start').params.threadId, 'active-thread');
});

test('restart marks interrupted and ambiguous deliveries without replaying tools or results', { timeout: 10000 }, async t => {
  const state = { cursor: '0', seen: ['old-id'], history: [], thread: null, inbox: [
    { id: 'a', text: 'old result', status: 'completed', result: 'saved', delivery: 'sending' },
    { id: 'b', text: 'legacy result', status: 'completed', result: 'saved' },
    { id: 'c', text: 'running', status: 'running', receipt: 'sending', outputs: [{ delivery: 'sending' }] },
  ] };
  const f = await fixture(t, { state });
  const status = await f.status();
  assert.ok(status.tasks.slice(1).every(job => job.delivery === 'unknown'));
  assert.equal(status.tasks[0].status, 'interrupted');
  assert.equal(status.tasks[0].receipt, 'unknown');
  assert.equal(status.tasks[0].outputs[0].delivery, 'unknown');
  assert.deepEqual((await f.disk()).seen, ['old-id']);
  assert.equal((await f.calls()).length, 0);
  assert.equal((await f.sent()).length, 0);
});

test('a result with unknown delivery is recorded and never automatically sent again', { timeout: 10000 }, async t => {
  const f = await fixture(t, { failResult: true });
  await f.push('one attempt');
  const status = await f.until(s => s.tasks[0]?.delivery === 'unknown');
  assert.equal(status.tasks[0].status, 'completed');
  assert.match(status.lastError, /结果投递未确认/);
  await f.command('/ping', /微信已连接/);
  assert.equal((await f.sent()).filter(message => message.item_list[0].text_item.text.startsWith('first answer')).length, 1);
});


test('a cancelled old poll cannot process messages or restore connection after logout', { timeout: 10000 }, async t => {
  const f = await fixture(t, { stalePoll: true });
  await f.until(async () => (await readFile(join(f.home, 'release.held'), 'utf8').catch(() => '')) === '1');
  await testControl(f.home, 'reconnect');
  await f.push('new connection task');
  await f.until(s => s.connected && s.tasks[0]?.delivery === 'sent');
  await testControl(f.home, 'logout');
  await f.release();
  await f.until(async s => !s.bound && !s.connected && (await readFile(join(f.home, 'release.returned'), 'utf8').catch(() => '')) === '1');
  const saved = await f.disk();
  assert.equal(saved.cursor, '');
  assert.equal(saved.inbox.length, 0);
  assert.equal((await f.calls()).filter(call => call.method === 'turn/start').length, 1);
});
