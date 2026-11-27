import test from 'node:test';
import assert from 'node:assert/strict';
import { Weixin, incoming, splitText, trustedOrigin, parseResponse } from '../runtime/weixin.mjs';
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
  assert.equal(defaults.sandbox, 'read-only');
  assert.equal((await validateSettings(valid)).timeoutMinutes, 0);
  assert.equal((await validateSettings({ ...valid, sandbox: 'danger-full-access' })).sandbox, 'danger-full-access');
  for (const value of [{ timeoutMinutes: -1 }, { timeoutMinutes: 1.5 }, { model: 'bad model' }, { sandbox: 'invalid' }, { workspace: 'relative' }, { persona: 'a'.repeat(4001) }]) await assert.rejects(validateSettings({ ...valid, ...value }));
});


test('uint64 message identifiers remain distinct and quoted text is untouched', async () => {
  const raw = '{"ret":0,"msgs":[{"message_id":18446744073709551610},{"message_id":18446744073709551611}],"text":"message_id: 18446744073709551611","msg_id":"unchanged"}';
  const client = new Weixin({ token: 'fixture' }, async () => new Response(raw));
  const batch = await client.updates('');
  assert.deepEqual(batch.msgs.map(message => message.message_id), ['18446744073709551610', '18446744073709551611']);
  assert.equal(batch.text, 'message_id: 18446744073709551611');
  assert.equal(batch.msg_id, 'unchanged');
  assert.equal(parseResponse('{"message_id":0}').message_id, '0');
});

test('idle poll deadlines preserve cursor and cancellation still propagates', async () => {
  let attempts = 0;
  const client = new Weixin({ token: 'fixture' }, async (_, request) => {
    assert.equal(JSON.parse(request.body).get_updates_buf, 'keep-cursor');
    if (++attempts === 1) throw new DOMException('idle', 'TimeoutError');
    return Response.json({ msgs: [], longpolling_timeout_ms: 55000 });
  });
  assert.deepEqual(await client.updates('keep-cursor'), { msgs: [] });
  await client.updates('keep-cursor');
  assert.equal(client.pollTimeout, 60000);
  const controller = new AbortController(); controller.abort();
  const cancelled = new Weixin({ token: 'fixture' }, async () => { throw new DOMException('cancelled', 'TimeoutError'); });
  await assert.rejects(cancelled.updates('', controller.signal));
  await assert.rejects(cancelled.send('owner', 'context', 'hello'));
});

test('specific authorization errors take precedence over a generic failure', async () => {
  const client = new Weixin({ token: 'fixture' }, async () => Response.json({ ret: -1, errcode: -14 }));
  await assert.rejects(client.updates(''), error => error.code === -14);
});

test('malformed inbound items cannot poison a batch or invent a duplicate id', () => {
  assert.equal(incoming(null), null);
  const message = { message_type: 1, from_user_id: 'owner', message_id: 'valid' };
  assert.equal(incoming({ ...message, item_list: {} }).text, '');
  assert.equal(incoming({ ...message, item_list: [null, { type: 1, text_item: { text: 'kept' } }] }).text, 'kept');
  assert.equal(incoming({ ...message, message_id: {} }).id, '');
  assert.equal(incoming({ ...message, message_id: Number.MAX_SAFE_INTEGER + 1 }).id, '');
});

test('send records exact server ids and keeps zero-code acceptance distinct from client delivery', async () => {
  const submissions = [];
  const requests = [];
  const responses = ['{"message_id":7532096231462383101}', '{"ret":0}', '{}'];
  const client = new Weixin({ token: 'private' }, async (_, request) => {
    requests.push(request);
    return new Response(responses.shift());
  }, async submission => { submissions.push(submission); });
  const result = await client.sendItem('owner', 'context', { type: 1, text_item: { text: 'hello' } });
  assert.equal(result.message_id, '7532096231462383101');
  assert.deepEqual(submissions.map(item => item.status), ['sending', 'accepted']);
  assert.equal(submissions[1].messageId, result.message_id);
  assert.equal(submissions[0].clientId, JSON.parse(requests[0].body).msg.client_id);
  const version = JSON.parse(requests[0].body).base_info.channel_version;
  const [major, minor, patch] = version.split('.').map(Number);
  assert.equal(Number(requests[0].headers['iLink-App-ClientVersion']), (major << 16) | (minor << 8) | patch);
  await client.send('owner', 'context', 'accepted without a message id');
  assert.equal(submissions.at(-1).status, 'accepted');
  assert.equal(submissions.at(-1).messageId, undefined);
  await assert.rejects(client.send('owner', 'context', 'invalid response'), /未返回有效确认/);
  assert.equal(submissions.at(-1).status, 'unknown');
  assert.equal(requests.length, 3);
  assert.doesNotMatch(JSON.stringify(submissions), /private|context|hello|accepted without/);
});

test('send failures remain durable and are submitted once', async () => {
  for (const response of [{ errcode: -14 }, null]) {
    const submissions = [];
    let attempts = 0;
    const client = new Weixin({ token: 'private' }, async () => {
      attempts++;
      if (!response) throw new Error('connection closed');
      return Response.json(response);
    }, async submission => { submissions.push(submission); });
    await assert.rejects(client.send('owner', 'context', 'test'));
    assert.equal(attempts, 1);
    assert.equal(submissions.at(-1).status, response ? 'rejected' : 'unknown');
    assert.ok(submissions.at(-1).finishedAt >= submissions[0].submittedAt);
  }
});
