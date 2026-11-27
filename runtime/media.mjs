import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep, resolve } from 'node:path';
import { constants } from 'node:fs';
import { Lexer, walkTokens } from 'marked';
import { home } from './store.mjs';
import { trustedOrigin } from './weixin.mjs';

export const mediaRoot = join(home, 'media');
const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c';
const kinds = { 2: ['image', 'image_item', '.jpg'], 3: ['voice', 'voice_item', '.silk'], 4: ['file', 'file_item', '.bin'], 5: ['video', 'video_item', '.mp4'] };
export function inside(root, path) { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); }
export function safeName(name) {
  let value = basename(String(name || 'attachment').replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_');
  while (Buffer.byteLength(value) > 180) value = value.slice(1);
  return value && value !== '.' && value !== '..' ? value : 'attachment';
}
export function mediaError(message) { return Object.assign(new Error(message), { mediaFailure: true }); }
export function parseKey(value, hex) {
  if (hex) { if (!/^[a-f0-9]{32}$/i.test(hex)) throw mediaError('附件解密密钥格式无效'); return Buffer.from(hex, 'hex'); }
  const key = Buffer.from(value || '', 'base64');
  if (key.length === 16) return key;
  if (key.length === 32 && /^[a-f0-9]{32}$/i.test(key.toString('ascii'))) return Buffer.from(key.toString('ascii'), 'hex');
  throw mediaError('附件缺少有效解密密钥');
}
export function encrypt(data, key) { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); }
export function decrypt(data, key) {
  try { const cipher = createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); }
  catch { throw mediaError('附件解密失败，请重新发送'); }
}
export async function fetchBytes(url, { fetcher = fetch, signal, maxBytes, method = 'GET', body } = {}) {
  trustedOrigin(url);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const progress = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(mediaError('附件传输连续 60 秒没有数据')), 60000); };
  progress();
  try {
    const response = await fetcher(url, { method, body, redirect: 'error', signal: combined, headers: method === 'POST' ? { 'Content-Type': 'application/octet-stream' } : undefined });
    progress();
    if (!response.ok) { await response.body?.cancel(); throw mediaError(`附件 CDN 请求失败（${response.status}）`); }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) { await response.body?.cancel(); throw mediaError('附件超过大小限制'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      combined.throwIfAborted(); size += chunk.length;
      if (size > maxBytes) { controller.abort(); throw mediaError('附件超过大小限制'); }
      chunks.push(chunk); progress();
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  } finally { clearTimeout(timer); }
}
export async function downloadItem(item, directory, maxBytes, { fetcher = fetch, signal } = {}) {
  const spec = kinds[item.type];
  if (!spec) throw mediaError('暂不支持这类附件');
  const [kind, field, extension] = spec;
  const info = item[field] || {};
  // A voice transcript is useful even when Weixin does not attach the original audio.
  if (kind === 'voice' && info.text && !info.media) return { kind, transcript: info.text };
  const reference = info.media;
  const url = reference?.full_url || (reference?.encrypt_query_param ? `${cdn}/download?encrypted_query_param=${encodeURIComponent(reference.encrypt_query_param)}` : undefined);
  if (!url) throw mediaError('微信附件缺少下载地址，请重新发送');
  const result = await fetchBytes(url, { fetcher, signal, maxBytes: maxBytes + 16 });
  const encrypted = Boolean(info.aeskey || reference.aes_key);
  if (!encrypted && kind !== 'image') throw mediaError('附件缺少解密信息');
  const bytes = encrypted ? decrypt(result.bytes, parseKey(reference.aes_key, info.aeskey)) : result.bytes;
  if (!bytes.length || bytes.length > maxBytes) throw mediaError('附件为空或超过大小限制');
  if (info.md5 && /^[a-f0-9]{32}$/i.test(info.md5) && createHash('md5').update(bytes).digest('hex') !== info.md5.toLowerCase()) throw mediaError('附件完整性校验失败');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = safeName(info.file_name || `${kind}${extension}`);
  const path = join(directory, randomUUID() + '-' + name);
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  return { kind, path, name, transcript: info.text || '', encodeType: info.encode_type, sampleRate: info.sample_rate, size: bytes.length };
}
export function inferKind(path) {
  const extension = extname(path).toLowerCase();
  if (['.jpg','.jpeg','.png','.gif','.webp'].includes(extension)) return 'image';
  if (['.mp4','.mov','.m4v','.webm'].includes(extension)) return 'video';
  if (['.wav','.silk','.mp3','.m4a','.aac','.ogg','.flac','.aiff'].includes(extension)) return 'voice';
  return 'file';
}
export async function snapshotFile(path, workspace, directory, maxBytes) {
  if (!isAbsolute(path)) throw mediaError('发送附件需要本机绝对路径');
  const [resolved, root, privateRoot] = await Promise.all([realpath(path), realpath(workspace), realpath(home).catch(error => { if (error.code === 'ENOENT') return resolve(home); throw error; })]);
  if (inside(privateRoot, resolved) && !inside(mediaRoot, resolved)) throw mediaError('不能将插件凭证和内部状态作为附件发送');
  if (!inside(root, resolved) && !inside(mediaRoot, resolved)) throw mediaError('发送的文件须位于工作目录或本次媒体目录内');
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw mediaError('发送文件为空、类型无效或超过大小限制');
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) { const { bytesRead } = await file.read(bytes, size, bytes.length - size, null); if (!bytesRead) break; size += bytesRead; }
    if (size !== info.size) throw mediaError('发送文件在读取期间发生变化，请重试');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, randomUUID() + '-' + safeName(path));
    await writeFile(target, bytes.subarray(0, size), { mode: 0o600, flag: 'wx' });
    return { path: target, name: safeName(path), size };
  } finally { await file.close(); }
}
export async function uploadMedia(client, bytes, recipient, { kind, name, durationMs, sampleRate = 24000, signal } = {}) {
  if (!bytes.length) throw mediaError('无法发送空附件');
  const key = randomBytes(16); const encrypted = encrypt(bytes, key); const filekey = randomBytes(16).toString('hex');
  const md5 = createHash('md5').update(bytes).digest('hex');
  const response = await client.call('/ilink/bot/getuploadurl', { filekey, media_type: { image: 1, video: 2, file: 3 }[kind], to_user_id: recipient, rawsize: bytes.length, rawfilemd5: md5, filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex') }, { signal });
  const url = response.upload_full_url?.trim() || (response.upload_param ? `${cdn}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${filekey}` : undefined);
  if (!url) throw mediaError('微信未返回附件上传地址');
  const result = await fetchBytes(url, { fetcher: client.fetcher, signal, maxBytes: 65536, method: 'POST', body: encrypted });
  const param = result.headers.get('x-encrypted-param');
  if (!param) throw mediaError('微信 CDN 未确认附件上传');
  const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
  if (kind === 'image') return { type: 2, image_item: { media, mid_size: encrypted.length } };
  if (kind === 'video') return { type: 5, video_item: { media, video_size: encrypted.length, video_md5: md5 } };
  return { type: 4, file_item: { media, file_name: safeName(name), len: String(bytes.length), md5 } };
}
export function parseDelivery(answer) {
  const source = String(answer).replaceAll('\r\n', '\n');
  const tokens = Lexer.lex(source);
  const outputs = [];
  let cursor = 0;
  let text = '';
  for (const token of tokens) {
    const offset = source.indexOf(token.raw, cursor);
    if (offset < 0) continue;
    text += source.slice(cursor, offset);
    cursor = offset + token.raw.length;
    if (token.type !== 'paragraph') { text += token.raw; continue; }
    const lines = [];
    for (const line of token.raw.split('\n')) {
      const match = line.match(/^WEIXIN_(MEDIA|VOICE):\s*(\{.*\})\s*$/);
      if (!match) { if (/^WEIXIN_(MEDIA|VOICE):/.test(line)) throw mediaError('附件发送指令格式无效'); lines.push(line); continue; }
      let data; try { data = JSON.parse(match[2]); } catch { throw mediaError('附件发送指令格式无效'); }
      if (match[1] === 'VOICE') {
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 500) throw mediaError('单条语音回复应为 1 到 500 字');
        outputs.push({ kind: 'voice', text: data.text });
      } else {
        if (typeof data.path !== 'string' || !['auto', 'image', 'voice', 'video', 'file'].includes(data.kind || 'auto')) throw mediaError('附件路径或发送类型无效');
        if (!outputs.some(output => output.path === data.path)) outputs.push({ kind: data.kind || 'auto', path: data.path });
      }
    }
    text += lines.join('\n');
  }
  text += source.slice(cursor);
  walkTokens(tokens, token => {
    if (!['image', 'link'].includes(token.type) || !(/^(?:[A-Za-z]:[\\/]|[\\/])/.test(token.href || ''))) return;
    let path; try { path = decodeURIComponent(token.href); } catch { return; }
    const found = outputs.find(output => output.path === path);
    if (found) found.reference = token.raw;
    else outputs.push({ path, kind: 'auto', reference: token.raw });
  });
  if (outputs.length > 4) throw mediaError('每轮最多发送 4 个附件或语音');
  return { text: text.trim(), outputs };
}
