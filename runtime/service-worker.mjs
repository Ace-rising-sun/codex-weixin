import { createWriteStream } from "node:fs";
import { Console } from "node:console";
import { join, dirname, delimiter } from "node:path";
const isWindows = process.platform === "win32";
const index = process.argv.indexOf("--home");
if (index >= 0 && process.argv[index + 1])
  process.env.CODEX_WEIXIN_HOME = process.argv[index + 1];
const { home, read } = await import("./store.mjs");
const config = await read("service", null);
if (!config?.codex) throw new Error("后台缺少 Codex 安装信息，请重新安装");
process.env.CODEX_WEIXIN_CODEX = config.codex;
process.env.PATH =
  dirname(config.node) + delimiter + (config.path || process.env.PATH || "");
if (isWindows) {
  const log = createWriteStream(join(home, "daemon.log"), { flags: "a" });
  const logger = new Console(log);
  console.error = logger.error.bind(logger);
}
try {
  await import("./daemon.mjs");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
