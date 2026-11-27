import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { openThread } from './platform.mjs';
import { control } from './control.mjs';
const uri = 'ui://codex-weixin/settings';
const resource = { uri, name: '微信 Codex 设置', mimeType: 'text/html;profile=mcp-app' };
const historyUri = 'ui://codex-weixin/history';
const historyResource = { uri: historyUri, name: '微信会话历史', mimeType: 'text/html;profile=mcp-app' };
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const appOnly = { ui: { visibility: ['app'] } };
const native = { readTool: 'weixin.settings.entry', updateTool: 'weixin.settings.save' };
const tools = [
  { name: native.readTool, title: '微信设置入口', inputSchema: object({}), outputSchema: { type: 'object', properties: { schema: { type: 'object' }, values: { type: 'object' }, layout: { type: 'array', items: { type: 'object' } } }, required: ['schema', 'values', 'layout'] }, annotations: { readOnlyHint: true }, _meta: appOnly },
  { name: 'weixin.settings.open', title: '打开设置', description: '打开微信 Codex 的扫码连接、独立模型和工作目录设置。', inputSchema: object({}), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: uri }, 'openai/outputTemplate': uri, 'openai/ui': { entrypoints: [{ type: 'global' }] } } },
  { name: 'weixin.history.view', title: '会话历史', description: '打开独立的微信会话历史列表，搜索并跳转到原 Codex 对话。', inputSchema: object({}), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: historyUri }, 'openai/outputTemplate': historyUri, 'openai/ui': { entrypoints: [{ type: 'global' }] } } },
  { name: 'weixin.history.list', title: '读取会话历史', inputSchema: object({}), annotations: { readOnlyHint: true }, _meta: appOnly },
  { name: 'weixin.status', title: '读取微信状态', inputSchema: object({}), annotations: { readOnlyHint: true }, _meta: appOnly },
  ...['login', 'cancelLogin', 'reconnect', 'logout', 'stop'].map(action => ({ name: 'weixin.' + action, title: ({ login: '本人扫码连接微信', cancelLogin: '取消扫码', reconnect: '重新连接', logout: '断开微信', stop: '停止当前任务' })[action], inputSchema: object({}), annotations: { destructiveHint: action === 'logout' }, _meta: appOnly })),
  { name: 'weixin.pin', title: '提交手机验证码', inputSchema: { ...object({ pin: { type: 'string', pattern: '^\\d{4,12}$' } }), required: ['pin'] }, _meta: appOnly },
  { name: native.updateTool, title: '保存微信设置', inputSchema: { ...object({ workspace: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, persona: { type: 'string' }, timeoutMinutes: { type: 'integer', minimum: 0, maximum: 1440 }, sandbox: { type: 'string', enum: ['read-only', 'workspace-write'] }, maxMediaMb: { type: 'integer', minimum: 1, maximum: 100 } }), required: ['workspace', 'model', 'effort', 'persona', 'timeoutMinutes', 'sandbox'] }, _meta: appOnly },
  { name: 'weixin.history.open', title: '打开历史会话', inputSchema: { ...object({ id: { type: 'string' } }), required: ['id'] }, _meta: appOnly },
];
async function call(name, args) {
  if (name === native.readTool) return { schema: object({}), values: {}, layout: [{ kind: 'group', title: '微信 Codex', items: [{ kind: 'tool', tool: 'weixin.settings.open' }, { kind: 'tool', tool: 'weixin.history.view' }] }] };
  if (name === 'weixin.settings.open' || name === 'weixin.history.view') return { ready: true };
  if (name === 'weixin.history.list') return control('history');
  if (name === 'weixin.history.open') {
    const data = await control('history');
    if (!data.history.some(x => x.id === args.id) || !/^[a-f0-9-]{36}$/.test(args.id)) throw new Error('找不到该会话');
    await openThread(args.id);
    return { opened: true };
  }
  const actions = { 'weixin.status': 'status', 'weixin.settings.save': 'save', ...Object.fromEntries(['login','cancelLogin','reconnect','logout','stop','pin'].map(key => ['weixin.' + key, key])) };
  if (!actions[name]) throw new Error('未知工具');
  return control(actions[name], args);
}
async function dispatch(method, params) {
  const extension = { 'openai/settings': native };
  const capabilities = { tools: {}, resources: {}, extensions: extension };
  if (method === 'server/discover') return { resultType: 'complete', supportedVersions: ['2026-07-28', '2025-11-25'], ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'weixin-settings', version: '0.4.0' } }, capabilities };
  if (method === 'initialize') return { protocolVersion: params.protocolVersion, serverInfo: { name: 'weixin-settings', version: '0.4.0' }, capabilities: { ...capabilities, experimental: extension } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'resources/list') return { resources: [resource, historyResource] };
  if (method === 'resources/templates/list') return { resourceTemplates: [] };
  if (method === 'resources/read' && params.uri === historyUri) return { contents: [{ ...historyResource, text: await readFile(new URL('./history.html', import.meta.url), 'utf8') }] };
  if (method === 'resources/read' && params.uri === uri) return { contents: [{ ...resource, text: await readFile(new URL('./settings.html', import.meta.url), 'utf8') }] };
  if (method === 'tools/call') {
    try { return { content: [], structuredContent: await call(params.name, params.arguments || {}) }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: /^[\p{Script=Han}]/u.test(error.message) ? error.message : '微信后台未就绪，请运行项目中的安装程序后重试。' }] }; }
  }
  throw new Error('不支持的请求');
}
createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  try { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: await dispatch(message.method, message.params || {}) }) + '\n'); }
  catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: '微信设置请求失败' } }) + '\n'); }
});
