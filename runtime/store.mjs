import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dataHome, isWindows, socketFor } from './platform.mjs';
import { memoryDirectory } from './memory.mjs';
import { join, isAbsolute } from 'node:path';
export const home = dataHome;
export const socket = socketFor(home);
export { isWindows };
export async function read(name, fallback) {
  try { return JSON.parse(await readFile(join(home, name + '.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function save(name, value) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, name + '.json');
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
export const defaults = { workspace: homedir(), model: 'gpt-6.2-sol', effort: 'high', persona: '表达自然，先回答结果。清楚说明实际完成的工作与待确认事项。', timeoutMinutes: 0, sandbox: 'read-only', maxMediaMb: 20, memoryDirectory: join(home, 'memory'), memoryCapacity: 100 };
export async function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
  const result = { ...defaults, ...value };
  if (!isAbsolute(result.workspace) || !(await stat(result.workspace)).isDirectory()) throw new Error('请选择存在的绝对工作目录');
  if (typeof result.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(result.model)) throw new Error('模型 ID 无效');
  if (!['low', 'medium', 'high', 'xhigh'].includes(result.effort)) throw new Error('推理强度无效');
  if (!Number.isInteger(result.timeoutMinutes) || result.timeoutMinutes < 0 || result.timeoutMinutes > 1440) throw new Error('执行时限应为 0 到 1440 分钟');
  if (!['read-only', 'workspace-write'].includes(result.sandbox)) throw new Error('执行权限无效');
  if (typeof result.persona !== 'string' || result.persona.length > 4000) throw new Error('人设最多 4000 字');
  if (!Number.isInteger(result.maxMediaMb) || result.maxMediaMb < 1 || result.maxMediaMb > 100) throw new Error('附件大小限制应为 1 到 100 MB');
  result.memoryDirectory = memoryDirectory(result.memoryDirectory);
  if (!Number.isInteger(result.memoryCapacity) || result.memoryCapacity < 1 || result.memoryCapacity > 1000) throw new Error('记忆容量应为 1 到 1000 条');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, result[key]]));
}

export async function controlKey() {
  if (!isWindows) return null;
  const existing = await read('control', null);
  if (existing) {
    if (!/^[a-f0-9]{64}$/.test(existing.key || '')) throw new Error('本机控制凭证无效，请核对 control.json');
    return existing.key;
  }
  await mkdir(home, { recursive: true });
  const key = randomBytes(32).toString('hex');
  try { await writeFile(join(home, 'control.json'), JSON.stringify({ key }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return controlKey(); }
  return key;
}
