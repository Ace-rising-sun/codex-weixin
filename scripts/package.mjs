import { create, list } from 'tar';
import { checkPrivacy } from './privacy.mjs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json")));
const output = join(root, "release");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, ".stage-"));
const name = `codex-weixin-${pkg.version}`;
const source = join(stage, name);
await mkdir(source);
const entries = [
  ".agents",
  ".codex-plugin",
  ".mcp.json",
  ".gitignore",
  "runtime",
  "skills",
  "test",
  "scripts",
  "docs",
  "package.json",
  "package-lock.json",
  "install.mjs",
  "manage.mjs",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "THIRD-PARTY-NOTICES.md",
];
try {
  for (const entry of entries)
    await cp(join(root, entry), join(source, entry), { recursive: true });
  const filename = name + ".tar.gz";
  await checkPrivacy(source);
  await create({ file: join(output, filename), cwd: stage, gzip: true, portable: true, mtime: new Date(0), noPax: true }, [name]);
  const names = [];
  await list({ file: join(output, filename), onReadEntry(entry) {
    if (entry.uname || entry.gname || entry.uid || entry.gid) throw new Error('发布包带有文件所有者元数据');
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..') || /(?:^|\/)\._/.test(entry.path)) throw new Error('发布包路径或扩展属性无效');
    names.push(entry.path);
  } });
  if (!names.includes(name + '/.mcp.json')) throw new Error('发布包缺少 MCP 配置');
  const digest = createHash("sha256")
    .update(await readFile(join(output, filename)))
    .digest("hex");
  await writeFile(join(output, "SHA256SUMS"), `${digest}  ${filename}\n`);
  console.log(join(output, filename));
} finally {
  await rm(stage, { recursive: true, force: true });
}
