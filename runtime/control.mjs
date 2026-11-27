import { request } from 'node:http';
import { socket, controlKey } from './store.mjs';
export async function control(action, body = {}) {
  const key = await controlKey();
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/' + action, method: 'POST', timeout: 45000, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) } }, response => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', chunk => { text += chunk; if (text.length > 8 * 1024 * 1024) req.destroy(new Error('后台响应过大')); });
      response.on('end', () => { try { const data = JSON.parse(text); if (data.error) reject(new Error(data.error)); else resolve(data); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('微信后台响应超时')));
    req.end(JSON.stringify(body));
  });
}
