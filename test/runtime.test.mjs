import { isWindows, socketFor } from '../runtime/platform.mjs';
import { fileURLToPath } from 'node:url';
import { testControl } from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
const root = new URL('../', import.meta.url);
function rpc(child) {
  let id = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  return (method, params = {}) => new Promise(resolve => { const key = ++id; pending.set(key, resolve); child.stdin.write(JSON.stringify({ id: key, jsonrpc: '2.0', method, params }) + '\n'); });
}
test('MCP discovers native settings and app resource without side effects', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/settings.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const call = rpc(child);
    const initialized = await call('initialize', { protocolVersion: '2025-11-25' });
    assert.equal(initialized.result.capabilities.extensions['openai/settings'].readTool, 'weixin.settings.entry');
    const listed = await call('tools/list');
    assert.ok(listed.result.tools.find(x => x.name === 'weixin.login')._meta.ui.visibility.includes('app'));
    const entry = await call('tools/call', { name: 'weixin.settings.entry' });
    assert.deepEqual(entry.result.structuredContent.layout[0].items.map(item=>item.tool), ['weixin.settings.open','weixin.history.view']);
    const historyTool=listed.result.tools.find(item=>item.name==='weixin.history.view');
    assert.equal(historyTool._meta.ui.resourceUri,'ui://codex-weixin/history');
    const historyPage=await call('resources/read',{uri:'ui://codex-weixin/history'});
    assert.match(historyPage.result.contents[0].text,/搜索会话或工作目录/);
    assert.doesNotMatch((await call('resources/read',{uri:'ui://codex-weixin/settings'})).result.contents[0].text,/id="history"/);
    const resource = await call('resources/read', { uri: 'ui://codex-weixin/settings' });
    assert.match(resource.result.contents[0].text, /手机显示的验证码/);
    assert.doesNotMatch(JSON.stringify(listed), /bot_token/);
  } finally { child.kill(); }
});
const control=testControl;
test('daemon uses private storage, settings persist, and a second process cannot steal socket', { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'weixin-test-'));
  const env = { ...process.env, CODEX_WEIXIN_HOME: home };
  const start = () => spawn(process.execPath, [fileURLToPath(new URL('../runtime/daemon.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = start(); let error = ''; child.stderr.on('data', x => error += x);
  try {
    let status;
    for (let i = 0; i < 60; i++) { try { status = await control(home, 'status'); break; } catch { await delay(50); } }
    assert.ok(status, error); assert.equal(status.bound, false); assert.equal(status.account, null);
    const changed = await control(home, 'save', { ...status.settings, workspace: home, model: 'gpt-test', timeoutMinutes: 2 });
    assert.equal(changed.settings.model, 'gpt-test');
    assert.equal(JSON.parse(await readFile(join(home, 'settings.json'))).timeoutMinutes, 2);
    if (!isWindows) assert.equal((await stat(join(home, 'settings.json'))).mode & 0o777, 0o600);
    if (isWindows) {
      const rejected = await new Promise((resolve,reject) => {
        const req=request({socketPath:socketFor(home),path:'/status',method:'POST'},response=>{response.resume();resolve(response.statusCode);});
        req.on('error',reject);req.end('{}');
      });
      assert.equal(rejected,401);
    }
    const second = start();
    const code = await new Promise(resolve => second.on('exit', resolve)); assert.notEqual(code, 0);
    assert.equal((await control(home, 'status')).settings.model, 'gpt-test');
    const unrestricted = await control(home, 'save', { ...status.settings, workspace: home, sandbox: 'danger-full-access' });
    assert.equal(unrestricted.settings.sandbox, 'danger-full-access');
    const invalid = await control(home, 'save', { ...status.settings, workspace: home, sandbox: 'invalid' }); assert.ok(invalid.error);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await rm(home, { recursive: true, force: true });
  }
});

test('native memory tools preserve large Unicode backups and remain app-only', { timeout: 15000 }, async t => {
  const { fixture } = await import('./bridge-fixture.mjs');
  const { accountKey } = await import('../runtime/tasks.mjs');
  const { randomUUID } = await import('node:crypto');
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/settings.mjs', import.meta.url))], { env: { ...process.env, CODEX_WEIXIN_HOME: f.home }, stdio: ['pipe','pipe','inherit'] });
  t.after(() => child.kill());
  const call = rpc(child);
  await call('initialize', { protocolVersion: '2025-11-25' });
  const listed = await call('tools/list');
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'weixin.memory.change')._meta.ui.visibility, ['app']);
  const entries = Array.from({length:100}, (_,index) => ({ id:'M'+(index+1).toString(36).toUpperCase().padStart(4,'0'), text:'中文字🌞'.repeat(40), tags:['备份'], mode:'relevant', updatedAt:index+1 }));
  const document = JSON.stringify({version:1,accountKey:accountKey({owner:'owner',bot:'bot'}),nextId:101,entries,operations:[]});
  const restored = await call('tools/call', {name:'weixin.memory.change',arguments:{requestId:randomUUID(),action:'restore',document}});
  assert.equal(restored.result.isError,undefined);
  const response = await call('tools/call',{name:'weixin.memory.list',arguments:{}});
  assert.deepEqual(response.result.structuredContent.entries.map(entry=>entry.text), entries.map(entry=>entry.text));
  const exported = await call('tools/call',{name:'weixin.memory.export',arguments:{format:'json'}});
  assert.deepEqual(JSON.parse(exported.result.structuredContent.text).entries, entries);
  const page = await call('resources/read',{uri:'ui://codex-weixin/settings'});
  assert.match(page.result.contents[0].text,/id="memory-form"/);
  assert.match(page.result.contents[0].text,/固定助手记忆目录/);
  await f.command('/memory list --page 2',/第 2\/10 页/);
  assert.equal((await f.calls()).length,0);
});
