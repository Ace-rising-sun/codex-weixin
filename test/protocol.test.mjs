import test from 'node:test';
import assert from 'node:assert/strict';
import { Weixin, incoming, splitText, trustedOrigin } from '../runtime/weixin.mjs';
import { validateSettings, defaults } from '../runtime/store.mjs';
import { tmpdir } from 'node:os';

test('credentials stay on approved HTTPS origins', () => {
  for (const url of ['https://evil.test', 'http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://user@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444']) assert.throws(() => trustedOrigin(url));
  assert.equal(trustedOrigin('https://ilinkai.weixin.qq.com/path'), 'https://ilinkai.weixin.qq.com');
});
test('self binding uses POST, omits bearer, PIN belongs to status poll', async () => {
  const requests = [];
  const client = new Weixin({}, async (url, request) => { requests.push({ url, ...request }); return Response.json({ ret: 0 }); });
  await client.qr(); await client.pollLogin('qr value', '123456', 'https://ilinkai.weixin.qq.com');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), { local_token_list: [] });
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.match(requests[1].url, /verify_code=123456/);
});
test('result send binds recipient context and never retries ambiguous delivery', async () => {
  let attempts = 0;
  const client = new Weixin({ token: 'private', baseurl: 'https://ilinkai.weixin.qq.com' }, async (_, request) => {
    attempts++; const body = JSON.parse(request.body);
    assert.equal(body.msg.to_user_id, 'owner'); assert.equal(body.msg.context_token, 'context'); assert.equal(request.headers.Authorization, 'Bearer private');
    throw new Error('network interrupted');
  });
  await assert.rejects(client.send('owner', 'context', 'hello'));
  assert.equal(attempts, 1);
});
test('backend error codes are preserved for session pause', async () => {
  const client = new Weixin({ token: 'private' }, async () => Response.json({ errcode: -14 }));
  await assert.rejects(client.updates(''), error => error.code === -14);
});
test('text splits preserve unicode and exact contents', () => {
  const text = '你好🌞'.repeat(2000);
  const parts = splitText(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(x => x.length <= 3000 && !/[\uD800-\uDBFF]$/.test(x)));
});
test('incoming ignores outbound and groups and identifies unsupported media', () => {
  assert.equal(incoming({ message_type: 2, from_user_id: 'owner' }), null);
  assert.equal(incoming({ message_type: 1, from_user_id: 'owner', group_id: 'group' }), null);
  const job = incoming({ message_type: 1, from_user_id: 'owner', message_id: 42, item_list: [{ type: 1, text_item: { text: 'hello' } }, { type: 2 }] });
  assert.equal(job.text, 'hello'); assert.equal(job.id, '42'); assert.equal(job.hasMedia, true);
});
test('settings validate path, model, sandbox and timeout', async () => {
  const valid = { ...defaults, workspace: tmpdir() };
  assert.equal((await validateSettings(valid)).timeoutMinutes, 0);
  for (const value of [{ timeoutMinutes: -1 }, { timeoutMinutes: 1.5 }, { model: 'bad model' }, { sandbox: 'danger-full-access' }, { workspace: 'relative' }, { persona: 'a'.repeat(4001) }]) await assert.rejects(validateSettings({ ...valid, ...value }));
});
