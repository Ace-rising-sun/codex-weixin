import { execFileSync } from "node:child_process";
import { mkdir, cp, writeFile, readFile, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { home, save, read, defaults, controlKey } from "./runtime/store.mjs";
import { isWindows, codexExecutable } from "./runtime/platform.mjs";
import { stopService, registerService } from "./runtime/service.mjs";
import { control } from "./runtime/control.mjs";
export const root = dirname(fileURLToPath(import.meta.url));
function run(codex, args, capture = false) {
  return execFileSync(codex, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  });
}
export async function registerPlugin(codex) {
  const manifest = JSON.parse(
    await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const catalog = join(home, "plugins", manifest.version);
  const plugin = join(catalog, "codex-weixin");
  await mkdir(join(catalog, ".agents", "plugins"), { recursive: true });
  await mkdir(plugin, { recursive: true });
  for (const name of [
    ".codex-plugin",
    "runtime",
    "skills",
    "package.json",
    "package-lock.json",
    "LICENSE",
  ])
    await cp(join(root, name), join(plugin, name), { recursive: true });
  await writeFile(
    join(plugin, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "weixin-settings": {
            command: process.execPath,
            args: [join(root, "runtime", "settings.mjs")],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  const marketplace = JSON.parse(
    await readFile(
      join(root, ".agents", "plugins", "marketplace.json"),
      "utf8",
    ),
  );
  marketplace.plugins[0].source.path = "./codex-weixin";
  await writeFile(
    join(catalog, ".agents", "plugins", "marketplace.json"),
    JSON.stringify(marketplace, null, 2) + "\n",
  );
  const list = JSON.parse(
    run(codex, ["plugin", "marketplace", "list", "--json"], true),
  );
  const previous = list.marketplaces.find(
    (item) => item.name === "weixin-local",
  )?.marketplaceSource;
  if (previous && previous.sourceType !== "local")
    throw new Error("weixin-local 已被其他来源使用，请先核对");
  const canonical = (path) =>
    isWindows ? resolve(path).toLowerCase() : resolve(path);
  if (!previous || canonical(previous.source) !== canonical(catalog)) {
    if (previous)
      run(codex, ["plugin", "marketplace", "remove", "weixin-local"]);
    try {
      run(codex, ["plugin", "marketplace", "add", catalog]);
    } catch (error) {
      if (previous)
        run(codex, ["plugin", "marketplace", "add", previous.source]);
      throw error;
    }
  }
  run(codex, ["plugin", "add", "codex-weixin@weixin-local"]);
}
export async function install() {
  if (
    !["darwin", "win32"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch) ||
    (isWindows && process.arch !== "x64")
  )
    throw new Error("支持 macOS Apple Silicon / Intel 和 Windows x64");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19))
    throw new Error("请安装 Node.js 22.19 或更新版本");
  const codex = codexExecutable();
  run(codex, ["login", "status"]);
  await access(join(root, "node_modules", "qrcode"));
  process.umask(0o077);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const status = await control("status").catch((error) => {
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return null;
    throw error;
  });
  if (
    status &&
    (status.busy || status.current || status.tasks.some((item) => item.status === "pending"))
  )
    throw new Error("微信任务正在运行，请稍后更新");
  if (!(await read("settings", null)))
    await save("settings", { ...defaults, workspace: root });
  await controlKey();
  if (process.argv.includes("--plugin-only")) {
    await registerPlugin(codex);
    return;
  }
  const previous = await read("service", null);
  await stopService();
  try {
    await registerService({
      node: process.execPath,
      entry: join(root, "runtime", "service-worker.mjs"),
      root,
      codex,
      path: process.env.PATH || "",
    });
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = await control("status");
        if (ready) break;
      } catch {}
      await delay(100);
    }
    if (!ready)
      throw new Error("后台启动失败，请查看私有数据目录中的 daemon.log");
    await registerPlugin(codex);
  } catch (error) {
    if (previous) {
      await stopService();
      await registerService(previous);
    }
    throw error;
  }
  console.log(
    "微信 Codex 已安装。重新打开 Codex，在插件详情选择“打开设置”或“会话历史”。已有绑定会保留。",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  install().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
