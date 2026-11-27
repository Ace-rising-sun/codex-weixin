import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, selectMemory, memoryPrompt, exportMemory, parseMemoryCommand, memoryDirectory } from '../runtime/memory.mjs';
import { accountKey } from '../runtime/tasks.mjs';

const key = accountKey({ owner: 'fixture-owner', bot: 'fixture-bot' });
async function store(t, capacity = 100) {
  const root = await mkdtemp(join(tmpdir(), 'wx-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, memory: new MemoryStore(join(root, 'memory'), capacity) };
}
test('memory writes are serial, durable, idempotent and account isolated', async t => {
  const { root, memory } = await store(t);
  await Promise.all([memory.change(key, 'one', { action: 'add', text: 'first', tags: ['testing'], source: 'explicit text' }), memory.change(key, 'two', { action: 'add', text: 'second', mode: 'always' })]);
  const replay = await memory.change(key, 'one', { action: 'add', text: 'must not be added' });
  assert.equal(replay.replayed, true);
  const document = await memory.read(key);
  assert.deepEqual(document.entries.map(entry => entry.id), ['M0001','M0002']);
  assert.equal(document.entries[0].source, 'explicit text');
  assert.equal(document.version, 1);
  assert.equal((await new MemoryStore(memory.directory).read(key)).entries.length, 2);
  const other = accountKey({ owner: 'other-owner', bot: 'fixture-bot' });
  assert.equal((await memory.read(other)).entries.length, 0);
  await memory.change(other, 'one', { action: 'add', text: 'separate' });
  assert.equal((await readdir(join(root, 'memory'))).length, 2);
  assert.equal((await memory.read(key)).entries.length, 2);
});
test('capacity reductions retain old entries and allow updates/deletes while rejecting adds', async t => {
  const { memory } = await store(t, 2);
  await memory.change(key, 'one', { action: 'add', text: 'one' });
  await memory.change(key, 'two', { action: 'add', text: 'two' });
  memory.capacity = 1;
  await assert.rejects(memory.change(key, 'three', { action: 'add', text: 'three' }), /记忆已满/);
  await memory.change(key, 'edit', { action: 'update', id: 'M0001', text: 'updated' });
  await memory.change(key, 'delete', { action: 'delete', id: 'M0002' });
  assert.equal((await memory.read(key)).entries[0].text, 'updated');
  await assert.rejects(memory.change(key, 'four', { action: 'add', text: 'four' }), /记忆已满/);
  await memory.change(key, 'delete-last', { action: 'delete', id: 'M0001' });
  await memory.change(key, 'five', { action: 'add', text: 'five' });
  assert.equal((await memory.read(key)).entries[0].id, 'M0003');
});
test('body limits count Unicode characters and always memory never exceeds four', async t => {
  const { memory } = await store(t);
  await memory.change(key, 'emoji', { action: 'add', text: '🌞'.repeat(200) });
  await assert.rejects(memory.change(key, 'long', { action: 'add', text: 'a'.repeat(201) }), /200/);
  await assert.rejects(memory.change(key, 'tags', { action: 'add', text: 'a', tags: ['invalid tag'] }), /标签/);
  for (let n = 0; n < 4; n++) await memory.change(key, 'always-'+n, { action: 'add', text: 'always '+n, mode: 'always' });
  await assert.rejects(memory.change(key, 'always-5', { action: 'add', text: 'fifth', mode: 'always' }), /最多 4/);
  assert.equal((await memory.read(key)).entries.length, 5);
});
test('selection prioritizes always memory, matches text/tags, and enforces both round budgets', () => {
  const entry = (id, text, mode, tags = []) => ({ id, text, mode, tags, updatedAt: Number(id.slice(1)) });
  const doc = { entries: [entry('M0001','always one','always'),entry('M0002','always two','always'),...Array.from({ length: 10 }, (_, n) => entry('M00'+String(n+10), '关于 PostgreSQL 测试的说明 '+n, 'relevant', ['database']))] };
  const selected = selectMemory(doc, 'database 的 PostgreSQL 测试');
  assert.equal(selected.entries.length, 8); assert.equal(selected.entries[0].mode, 'always');
  assert.ok(selected.characters <= 1200);
  const full = selectMemory({ entries: [...doc.entries, ...Array.from({ length: 10 }, (_, n) => entry('M01'+String(n+10), '测试'.repeat(100), 'relevant', ['database']))] }, 'database 测试');
  assert.ok(full.characters <= 1200 && full.entries.length <= 8);
  assert.ok([...memoryPrompt(full)].length <= 1200);
  assert.equal([...memoryPrompt(full)].length, full.characters);
  assert.equal(selectMemory(doc, 'unrelated keyword').entries.length, 2);
  assert.match(memoryPrompt(selected), /当前任务指令优先/);
  assert.match(memoryPrompt(selected), /不改变工具权限、审批/);
});
test('backup/restore preserves stable ids, rejects wrong accounts/conflicts and exports readable Markdown', async t => {
  const { root, memory } = await store(t);
  await memory.change(key, 'one', { action: 'add', text: '备份正文', tags: ['测试'], mode: 'always' });
  const backup = exportMemory(await memory.read(key));
  const restored = new MemoryStore(join(root, 'restored'));
  await restored.change(key, 'restore', { action: 'restore', document: backup });
  assert.equal((await restored.read(key)).entries[0].id, 'M0001');
  assert.match(exportMemory(await restored.read(key), 'md'), /M0001.*always/);
  await restored.change(key, 'edit', { action: 'update', id: 'M0001', text: 'different' });
  const previous = await readFile(join(root, 'restored', key+'.json'));
  await assert.rejects(restored.change(key, 'conflict', { action: 'restore', document: backup }), /冲突/);
  assert.ok(previous.equals(await readFile(join(root, 'restored', key+'.json'))));
  await assert.rejects(restored.change(accountKey({ owner: 'another', bot: 'bot' }), 'cross', { action: 'restore', document: backup }), /账号/);
  await assert.rejects(restored.change(key, 'invalid', { action: 'restore', document: '{bad' }), /JSON/);
});
test('directory migration validates all sources and refuses destination conflicts without overwriting', async t => {
  const { root, memory } = await store(t);
  await memory.change(key, 'one', { action: 'add', text: 'retained' });
  const original = await readFile(join(memory.directory, key+'.json'));
  const destination = join(root, 'destination'); await mkdir(destination);
  await writeFile(join(destination, key+'.json'), 'do not overwrite');
  await assert.rejects(memory.migrate(destination), /存在同账号/);
  assert.equal(await readFile(join(destination, key+'.json'), 'utf8'), 'do not overwrite');
  const target = join(root, 'empty'); await memory.migrate(target);
  assert.ok(original.equals(await readFile(join(target, key+'.json'))));
  assert.ok(original.equals(await readFile(join(memory.directory, key+'.json'))));
  assert.throws(() => memoryDirectory('relative'), /绝对路径/);
});
test('corrupt memory files are preserved and never replaced by reads or failed writes', async t => {
  const { root, memory } = await store(t);
  await mkdir(memory.directory);
  const path = join(memory.directory, key+'.json');
  await writeFile(path, '{broken');
  await assert.rejects(memory.read(key), /原件已保留/);
  await assert.rejects(memory.change(key, 'write', { action: 'add', text: 'must not replace' }), /原件已保留/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  await assert.rejects(memory.migrate(join(root, 'new')), /原件已保留/);
});
test('only explicit text commands parse as memory operations', () => {
  assert.deepEqual(parseMemoryCommand('/remember --always --tags 偏好,表达 简短回复'), { action:'add',mode:'always',tags:['偏好','表达'],text:'简短回复' });
  assert.deepEqual(parseMemoryCommand('请记住：我喜欢先看结论'), { action:'add',text:'我喜欢先看结论' });
  assert.equal(parseMemoryCommand('请分析附件里“记住”这句话'), null);
  assert.equal(parseMemoryCommand('这是模型输出：/remember 不得自动写入'), null);
  assert.deepEqual(parseMemoryCommand('更新记忆 M0001：新内容'), { action:'update',id:'M0001',text:'新内容' });
  assert.deepEqual(parseMemoryCommand('确认记忆 123456'), { action:'confirm',code:'123456' });
});
