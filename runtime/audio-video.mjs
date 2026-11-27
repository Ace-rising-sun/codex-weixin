import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { isWindows, synthesizeSpeech } from './platform.mjs';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { join } from 'node:path';
import { decode, isSilk, getDuration } from 'silk-wasm';
import { Worker } from 'node:worker_threads';
import { mediaError } from './media.mjs';
export const ffmpeg = process.env.CODEX_WEIXIN_FFMPEG || ffmpegInstaller.path;
const exec = promisify(execFile);
export async function convert(args, { signal, maxBuffer = 32 * 1024 * 1024 } = {}) {
  try { return await exec(ffmpeg, ['-nostdin', '-v', 'error', ...args], { signal, timeout: 120000, encoding: 'buffer', maxBuffer }); }
  catch (error) { if (signal?.aborted) throw signal.reason; throw mediaError('音视频转换失败，文件可能损坏或格式不受支持'); }
}
export function wavFromPcm(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
export async function voiceToWav(path, signal) {
  const raw = await readFile(path, { signal });
  if (!isSilk(raw)) return path;
  if (getDuration(raw) > 300000) throw mediaError('单条语音超过 5 分钟，请拆分发送');
  const pcm = await decode(raw, 24000); signal?.throwIfAborted();
  const target = path + '.wav'; await writeFile(target, wavFromPcm(pcm.data), { mode: 0o600 }); return target;
}
export async function speechFile(text, directory, signal) {
  const path = join(directory, isWindows ? 'speech.wav' : 'speech.aiff');
  try { await synthesizeSpeech(text, path, signal); }
  catch (error) { if (signal?.aborted) throw signal.reason; throw mediaError('系统语音合成失败，请检查系统中文语音是否已安装'); }
  return path;
}
let worker; let pending; let id = 0;
function closeWorker() { const current = worker; worker = null; if (current) void current.terminate(); }
export function transcribe(path, signal) {
  if (pending) throw mediaError('语音识别正在处理中');
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!worker) {
    const instance = new Worker(new URL('./asr-worker.mjs', import.meta.url), { execArgv: [] }); worker = instance;
    instance.on('message', message => { if (pending?.id === message.id) message.error ? pending.reject(mediaError(message.error)) : pending.resolve(message.text); });
    instance.on('error', () => { if (worker === instance) { pending?.reject(mediaError('本地语音识别启动失败')); closeWorker(); } });
    instance.on('exit', () => { if (worker === instance) { pending?.reject(mediaError('本地语音识别已退出')); worker = null; } });
  }
  return new Promise((resolve, reject) => {
    const abort = () => { closeWorker(); finish(reject, signal.reason); };
    const finish = (callback, value) => { signal?.removeEventListener('abort', abort); pending = null; callback(value); };
    const key = ++id;
    pending = { id: key, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage({ id: key, path });
  });
}
export async function transcribeFile(path, signal) {
  const { stdout } = await convert(['-protocol_whitelist', 'file,pipe', '-i', path, '-t', '301', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { signal, maxBuffer: 12 * 1024 * 1024 });
  if (!stdout.length || stdout.length > 300 * 16000 * 2) throw mediaError('语音为空或超过 5 分钟，请拆分发送');
  const pcmPath = path + '.asr.pcm'; await writeFile(pcmPath, stdout, { mode: 0o600 });
  return transcribe(pcmPath, signal);
}
export async function videoFrames(path, directory, signal) {
  // Six evenly spaced samples cover the whole clip, including the last scene.
  const info = await exec(ffmpeg, ['-nostdin', '-i', path], { signal, encoding: 'utf8', timeout: 30000 }).catch(error => { if (signal?.aborted) throw signal.reason; return { stderr: error.stderr }; });
  const match = String(info.stderr).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw mediaError('无法读取视频时长');
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const second = Math.max(0, duration * i / 6);
    const frame = join(directory, `frame-${i}.jpg`);
    await convert(['-protocol_whitelist', 'file,pipe', '-ss', String(second), '-i', path, '-frames:v', '1', '-vf', 'scale=960:-2', '-y', frame], { signal });
    frames.push({ path: frame, second });
  }
  return { frames, duration, hasAudio: /Audio:/.test(String(info.stderr)) };
}
export function disposeAudio() { pending?.reject(mediaError('语音识别已停止')); closeWorker(); }
