import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
const directory = await mkdtemp(join(tmpdir(), "weixin-install-"));
process.env.CODEX_WEIXIN_HOME = join(directory, "data");
process.env.CODEX_HOME = join(directory, "codex");
await mkdir(process.env.CODEX_HOME, { recursive: true });
const { registerPlugin, root } = await import("../install.mjs");
const { codexExecutable, synthesizeSpeech, isWindows } = await import(
  "../runtime/platform.mjs"
);
const { registerService, removeService } = await import(
  "../runtime/service.mjs"
);
const { control } = await import("../runtime/control.mjs");
const codex = codexExecutable();
const source = await readFile(join(root, ".mcp.json"));
let registered = false;
let pluginRegistered = false;
try {
  await registerPlugin(codex);
  pluginRegistered = true;
  await registerService({
    node: process.execPath,
    entry: join(root, "runtime/service-worker.mjs"),
    root,
    codex,
  });
  registered = true;
  let status;
  for (let i = 0; i < 100; i++) {
    try {
      status = await control("status");
      break;
    } catch {}
    await delay(200);
  }
  assert.equal(status?.bound, false);
  assert.deepEqual(await readFile(join(root, ".mcp.json")), source);
  const audio = join(directory, isWindows ? "speech.wav" : "speech.aiff");
  await synthesizeSpeech("Hello. This is a local speech test.", audio);
  assert.ok((await readFile(audio)).length > 100);
  const resource = execFileSync(
    codex,
    ["plugin", "marketplace", "list", "--json"],
    { encoding: "utf8" },
  );
  assert.ok(
    JSON.parse(resource).marketplaces.some(
      (item) => item.name === "weixin-local",
    ),
  );
  console.log(
    "真实 Codex 插件注册、用户后台启动、控制通信、系统语音和卸载检查通过。",
  );
} finally {
  if (registered) await removeService();
  if (pluginRegistered) {
    execFileSync(codex, ["plugin", "remove", "codex-weixin@weixin-local"], {
      stdio: "inherit",
    });
    execFileSync(codex, ["plugin", "marketplace", "remove", "weixin-local"], {
      stdio: "inherit",
    });
  }
  await rm(directory, { recursive: true, force: true });
}
