import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
const ignored = new Set(['.git', 'node_modules', 'release', 'coverage']);
const privateNames = new Set(['account.json', 'state.json', 'settings.json', 'control.json', 'service.json', 'daemon.log']);
const secrets = /(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
const userPaths = /(?:\/Users\/[^/\s"'<>]+|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+)/;
export async function checkPrivacy(root) {
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('公开源码包含符号链接，请核对 ' + entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (/^[0-9a-f]{64}\.json$/.test(entry.name)) throw new Error('公开源码包含账号记忆文件');
      if (privateNames.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) throw new Error('公开源码包含本机配置文件 ' + entry.name);
      const text = await readFile(path, 'utf8');
      if (secrets.test(text) || userPaths.test(text) || text.includes(homedir() + '/')) throw new Error('公开源码可能包含凭证或本机路径，请核对 ' + entry.name);
    }
  }
  await walk(root);
}
