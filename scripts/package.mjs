import { create, list } from 'tar';
import { checkPrivacy } from './privacy.mjs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const entries = [
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  ".gitignore",
  "package.json",
  "package-lock.json",
  "install.mjs",
  "manage.mjs",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "THIRD-PARTY-NOTICES.md",
];
const directories = ["runtime", "skills", "test", "scripts", "docs"];
const sourcePath =
  /^(?:(?:runtime|test|scripts)\/[a-z0-9][a-z0-9.-]*\.(?:mjs|html)|docs\/[a-z0-9-]+\.md|skills\/[a-z0-9-]+\/SKILL\.md)$/;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, windowsHide: true });
const commit = git("rev-parse", "--verify", "HEAD").toString().trim();
const paths = [...entries, ...directories];
if (git("diff", "--name-only", "-z", commit, "--", ...paths).length)
  throw Error("请先提交发布范围内的修改，再生成源码包。");

const files = git("ls-tree", "-rz", commit, "--", ...paths)
  .toString()
  .split("\0")
  .filter(Boolean)
  .map((record) => {
    const [metadata, path] = record.split("\t");
    const match = /^100(644|755) blob ([a-f0-9]+)$/.exec(metadata);
    if (!match || (!entries.includes(path) && !sourcePath.test(path)))
      throw Error("发布清单只允许普通源码文件，请检查是否提交了本机数据。");
    return { path, mode: Number.parseInt(match[1], 8), object: match[2] };
  });

const pkg = JSON.parse(git("show", `${commit}:package.json`).toString());
const output = join(root, "release");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, ".stage-"));
const name = `codex-weixin-${pkg.version}`;
const source = join(stage, name);
try {
  for (const { path, mode, object } of files) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, git("cat-file", "blob", object), { mode });
  }
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
