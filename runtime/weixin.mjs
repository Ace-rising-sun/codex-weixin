import { randomBytes, randomUUID } from 'node:crypto';
export function trustedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new Error('微信返回了不受信任的接口地址');
  return url.origin;
}
export class Weixin {
  constructor(account = {}, fetcher = fetch) { this.account = account; this.fetcher = fetcher; }
  async call(path, body, { timeout = 40000, origin, signal, authenticated = true } = {}) {
    const headers = { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(1024), 'AuthorizationType': 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') };
    if (authenticated) {
      if (!this.account.token) throw new Error('请先扫码连接微信');
      headers.Authorization = `Bearer ${this.account.token}`;
      body = { ...body, base_info: { channel_version: '0.4.0', bot_agent: 'CodexWeixin/0.4.0' } };
    }
    const response = await this.fetcher(trustedOrigin(origin || this.account.baseurl || 'https://ilinkai.weixin.qq.com') + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    if (!response.ok) throw Object.assign(new Error(`微信接口 HTTP ${response.status}`), { code: response.status });
    const result = await response.json();
    const code = result.ret || result.errcode;
    if (code) throw Object.assign(new Error(`微信接口返回错误 ${code}`), { code });
    return result;
  }
  qr() { return this.call('/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { origin: 'https://ilinkai.weixin.qq.com', authenticated: false }); }
  pollLogin(code, pin, origin, signal) {
    const query = new URLSearchParams({ qrcode: code });
    if (pin) query.set('verify_code', pin);
    return this.call('/ilink/bot/get_qrcode_status?' + query, undefined, { authenticated: false, origin, signal });
  }
  updates(cursor, signal) { return this.call('/ilink/bot/getupdates', { get_updates_buf: cursor || '' }, { signal }); }
  async sendItem(recipient, context, item, signal) {
    if (!context) throw new Error('当前聊天缺少回复凭证，请重新发送消息');
    return this.call('/ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: recipient, client_id: randomUUID(), message_type: 2, message_state: 2, context_token: context, item_list: [item] } }, { signal });
  }
  async send(recipient, context, text) {
    if (!context) throw new Error('当前聊天缺少回复凭证，请重新发送消息');
    // Each part is sent once. An unknown delivery outcome must not be retried automatically.
    for (const part of splitText(text)) {
      await this.sendItem(recipient, context, { type: 1, text_item: { text: part } });
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
  if (message.message_type !== 1 || !message.from_user_id || message.group_id) return null;
  const items = message.item_list || [];
  return { id: String(message.message_id || message.msg_id || ''), sender: message.from_user_id, context: message.context_token, text: items.filter(x => x.type === 1).map(x => x.text_item?.text || '').join('\n'), hasMedia: items.some(x => x.type !== 1), media: items.filter(x => [2, 3, 4, 5].includes(x.type)) };
}
