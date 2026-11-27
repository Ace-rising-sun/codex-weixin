import { randomBytes, randomUUID } from 'node:crypto';
import packageInfo from '../package.json' with { type: 'json' };

const [major, minor, patch] = packageInfo.version.split('.').map(Number);
const clientVersion = (major << 16) | (minor << 8) | patch;
export function trustedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new Error('微信返回了不受信任的接口地址');
  return url.origin;
}
// JSON numbers may already be rounded by the time a reviver receives their value.
// Node 22.19+ supplies the original token so uint64 identifiers remain exact.
export function parseResponse(text) {
  return JSON.parse(text, (key, value, context) => {
    if ((key === 'message_id' || key === 'msg_id') && typeof value === 'number') {
      if (!context?.source || !/^\d+$/.test(context.source)) throw new Error('微信消息编号格式无效');
      return context.source;
    }
    return value;
  });
}
export class Weixin {
  pollTimeout = 40000;
  constructor(account = {}, fetcher = fetch, onSend) { this.account = account; this.fetcher = fetcher; this.onSend = onSend; }
  async call(path, body, { timeout = 40000, origin, signal, authenticated = true } = {}) {
    const headers = { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(clientVersion), 'AuthorizationType': 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') };
    if (authenticated) {
      if (!this.account.token) throw new Error('请先扫码连接微信');
      headers.Authorization = `Bearer ${this.account.token}`;
      body = { ...body, base_info: { channel_version: packageInfo.version, bot_agent: 'CodexWeixin/' + packageInfo.version } };
    }
    const response = await this.fetcher(trustedOrigin(origin || this.account.baseurl || 'https://ilinkai.weixin.qq.com') + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    if (!response.ok) throw Object.assign(new Error(`微信接口 HTTP ${response.status}`), { code: response.status });
    const result = parseResponse(await response.text());
    const code = result.errcode || result.ret;
    if (code) throw Object.assign(new Error(`微信接口返回错误 ${code}`), { code });
    return result;
  }
  qr() { return this.call('/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { origin: 'https://ilinkai.weixin.qq.com', authenticated: false }); }
  pollLogin(code, pin, origin, signal) {
    const query = new URLSearchParams({ qrcode: code });
    if (pin) query.set('verify_code', pin);
    return this.call('/ilink/bot/get_qrcode_status?' + query, undefined, { authenticated: false, origin, signal });
  }
  async updates(cursor, signal) {
    try {
      const result = await this.call('/ilink/bot/getupdates', { get_updates_buf: cursor || '' }, { signal, timeout: this.pollTimeout });
      const timeout = result.longpolling_timeout_ms;
      if (Number.isInteger(timeout) && timeout >= 1000 && timeout <= 120000) this.pollTimeout = timeout + 5000;
      return result;
    } catch (error) {
      // An idle long poll reaching its deadline is not a broken connection.
      if (!signal?.aborted && error.name === 'TimeoutError') return { msgs: [] };
      throw error;
    }
  }
  async sendItem(recipient, context, item, signal, timeout) {
    if (!context) throw new Error('当前聊天缺少回复凭证，请重新发送消息');
    const submission = { clientId: randomUUID(), itemType: item.type, status: 'sending', submittedAt: Date.now() };
    await this.onSend?.(structuredClone(submission));
    try {
      const result = await this.call('/ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: recipient, client_id: submission.clientId, message_type: 2, message_state: 2, context_token: context, item_list: [item] } }, { signal, timeout });
      const messageId = typeof result.message_id === 'string' && /^[1-9]\d*$/.test(result.message_id) ? result.message_id : undefined;
      if (!messageId && result.ret !== 0 && result.errcode !== 0) throw new Error('微信发送接口未返回有效确认');
      Object.assign(submission, { status: 'accepted', messageId, ret: result.ret, errcode: result.errcode });
      return result;
    } catch (error) {
      submission.status = typeof error.code === 'number' ? 'rejected' : 'unknown';
      submission.errorCode = error.code || error.cause?.code || error.name;
      throw error;
    } finally {
      submission.finishedAt = Date.now();
      await this.onSend?.(structuredClone(submission));
    }
  }
  async send(recipient, context, text, { signal, timeout } = {}) {
    if (!context) throw new Error('当前聊天缺少回复凭证，请重新发送消息');
    // Each part is sent once. An unknown delivery outcome must not be retried automatically.
    for (const part of splitText(text)) {
      await this.sendItem(recipient, context, { type: 1, text_item: { text: part } }, signal, timeout);
    }
  }
}
export function splitText(text, max = 3000) {
  const parts = []; let part = '';
  for (const char of String(text)) { if (part.length + char.length > max) { parts.push(part); part = ''; } part += char; }
  if (part) parts.push(part);
  return parts;
}
export function incoming(message) {
  if (!message || message.message_type !== 1 || typeof message.from_user_id !== 'string' || !message.from_user_id || message.group_id) return null;
  const items = Array.isArray(message.item_list) ? message.item_list.filter(item => item && typeof item === 'object') : [];
  const id = message.message_id ?? message.msg_id;
  return {
    id: typeof id === 'string' || Number.isSafeInteger(id) ? String(id) : '',
    sender: message.from_user_id,
    context: typeof message.context_token === 'string' ? message.context_token : undefined,
    text: items.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n'),
    hasMedia: items.some(item => item.type !== 1),
    media: items.filter(item => [2, 3, 4, 5].includes(item.type)),
  };
}
