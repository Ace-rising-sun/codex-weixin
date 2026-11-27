import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve, delimiter } from "node:path";
import { promisify } from "node:util";
export const isWindows = process.platform === "win32";
export const dataHome =
  process.env.CODEX_WEIXIN_HOME ||
  (isWindows
    ? join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "Codex Weixin",
      )
    : join(homedir(), "Library", "Application Support", "Codex Weixin"));
export function socketFor(directory) {
  if (!isWindows) {
    const path = join(directory, "control.sock");
    return Buffer.byteLength(path) < 100
      ? path
      : join(
          "/tmp",
          "codex-weixin-" +
            createHash("sha256")
              .update(resolve(directory))
              .digest("hex")
              .slice(0, 24) +
            ".sock",
        );
  }
  return (
    "\\\\.\\pipe\\codex-weixin-" +
    createHash("sha256")
      .update(resolve(directory).toLowerCase())
      .digest("hex")
      .slice(0, 24)
  );
}
export const powershell = join(
  process.env.SystemRoot || "C:/Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
export function powershellSync(script, env = {}) {
  return execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop'; " + script,
        "utf16le",
      ).toString("base64"),
    ],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 30000,
    },
  ).trim();
}
export function codexExecutable() {
  if (process.env.CODEX_WEIXIN_CODEX) return process.env.CODEX_WEIXIN_CODEX;
  if (!isWindows)
    return execFileSync("/usr/bin/which", ["codex"], {
      encoding: "utf8",
    }).trim();
  const folders = (process.env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .map((value) => value.replace(/^"|"$/g, ""));
  const binary = folders
    .map((folder) => join(folder, "codex.exe"))
    .find(existsSync);
  if (binary) return binary;
  const shim = folders
    .map((folder) => join(folder, "codex.cmd"))
    .find(existsSync);
  const triple = {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
  }[process.arch];
  if (shim && triple) {
    const scope = join(dirname(shim), "node_modules", "@openai");
    const packageName = "codex-win32-" + process.arch;
    const candidate = [
      join(scope, packageName, "vendor", triple, "bin", "codex.exe"),
      join(
        scope,
        "codex",
        "node_modules",
        "@openai",
        packageName,
        "vendor",
        triple,
        "bin",
        "codex.exe",
      ),
      join(scope, "codex", "vendor", triple, "bin", "codex.exe"),
    ].find(existsSync);
    if (candidate) return candidate;
  }
  throw new Error("找不到 Codex CLI，请先安装并确认 codex --version 可用");
}
export async function openThread(id) {
  const uri = "codex://threads/" + id;
  if (isWindows)
    return powershellSync("Start-Process -FilePath $env:WEIXIN_OPEN_URI", {
      WEIXIN_OPEN_URI: uri,
    });
  return promisify(execFile)("/usr/bin/open", [uri]);
}
export async function synthesizeSpeech(text, path, signal) {
  const run = promisify(execFile);
  if (!isWindows)
    return run("/usr/bin/say", ["-v", "Tingting", "-o", path, "--", text], {
      signal,
      timeout: 120000,
    });
  const script = `Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'zh' } | Select-Object -First 1
  if ($env:WEIXIN_SPEECH_TEXT -match '[\\u4e00-\\u9fff]' -and !$voice) { throw 'Chinese speech voice is not installed. Install a Chinese language speech pack in Windows Settings.' }
  if ($voice) { $speaker.SelectVoice($voice.VoiceInfo.Name) }
  $speaker.SetOutputToWaveFile($env:WEIXIN_SPEECH_FILE)
  $speaker.Speak($env:WEIXIN_SPEECH_TEXT)
} finally { $speaker.Dispose() }`;
  return run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop'; " + script,
        "utf16le",
      ).toString("base64"),
    ],
    {
      env: {
        ...process.env,
        WEIXIN_SPEECH_TEXT: text,
        WEIXIN_SPEECH_FILE: path,
      },
      signal,
      windowsHide: true,
      timeout: 120000,
    },
  );
}
