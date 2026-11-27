import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, appendFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { testControl } from './support.mjs';

import { fixture } from './bridge-fixture.mjs';

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
  const done = await f.until(s => s.tasks.length === 2 && !s.busy && s.tasks.every(job => job.delivery === 'sent'));
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
  await f.until(s => !s.busy && s.tasks[0]?.delivery === 'sent');
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
  const done = await f.until(s => s.tasks.length === 2 && !s.busy && s.tasks.every(job => job.delivery === 'sent'));
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
  await f.until(s => !s.busy && s.tasks[0]?.delivery === 'sent');
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
  assert.equal((await f.sent()).filter(message => message.item_list[0].text_item.text.includes('first answer')).length, 1);
});


test('a cancelled old poll cannot process messages or restore connection after logout', { timeout: 10000 }, async t => {
  const f = await fixture(t, { stalePoll: true });
  await f.until(async () => (await readFile(join(f.home, 'release.held'), 'utf8').catch(() => '')) === '1');
  await testControl(f.home, 'reconnect');
  await f.push('new connection task');
  await f.until(s => s.connected && !s.busy && s.tasks[0]?.delivery === 'sent');
  const logout = await testControl(f.home, 'logout');
  assert.equal(logout.bound, false);
  await f.release();
  await f.until(async s => !s.bound && !s.connected && (await readFile(join(f.home, 'release.returned'), 'utf8').catch(() => '')) === '1');
  const saved = await f.disk();
  assert.equal(saved.cursor, '');
  assert.equal(saved.inbox.length, 0);
  assert.equal((await f.calls()).filter(call => call.method === 'turn/start').length, 1);
});


test('result delivery stays busy after model completion and guards logout and session changes', { timeout: 10000 }, async t => {
  const f = await fixture(t, { holdResult: true });
  await f.push('deliver slowly');
  await f.until(s => s.busy && !s.current && s.tasks[0]?.delivery === 'sending');
  const rejected = await testControl(f.home, 'logout');
  assert.match(rejected.error, /等待任务结束/);
  await f.command('/new', /包含结果回传/);
  await f.command('/status', /回传结果 是/);
  assert.equal((await f.status()).bound, true);
  await f.release();
  await f.until(s => !s.busy && s.tasks[0]?.delivery === 'sent');
  await f.command('/new', /已开始新会话/);
});
