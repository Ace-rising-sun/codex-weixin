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
    assert.equal((await stat(join(home, 'settings.json'))).mode & 0o777, 0o600);
    const second = start();
    const code = await new Promise(resolve => second.on('exit', resolve)); assert.notEqual(code, 0);
    assert.equal((await control(home, 'status')).settings.model, 'gpt-test');
    const invalid = await control(home, 'save', { ...status.settings, workspace: home, sandbox: 'danger-full-access' }); assert.ok(invalid.error);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await rm(home, { recursive: true, force: true });
  }
});
