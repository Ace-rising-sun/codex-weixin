import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Codex {
  #child;
  #pending = new Map();
  #nextId = 1;

  constructor({ executable, directory, onEvent, onExit }) {
    const childEnv = { ...process.env };
    delete childEnv.WECOM_BOT_ID;
    delete childEnv.WECOM_BOT_SECRET;
    const args = ['app-server', '--listen', 'stdio://'];
    const script = executable.endsWith('.cjs');
    const child = spawn(script ? process.execPath : executable, script ? [executable, ...args] : args, {
      cwd: directory,
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#child = child;

    const fail = () => {
      if (!this.#child) return;
      this.#child = undefined;
      if (child.exitCode === null && !child.killed) child.kill();
      for (const { reject } of this.#pending.values()) reject(new Error('Codex App Server 已退出'));
      this.#pending.clear();
      onExit(this);
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.stdin.on('error', fail);
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method) {
        onEvent(message);
      } else {
        const request = this.#pending.get(message.id);
        if (!request) return;
        if (message.error) request.reject(Object.assign(new Error(`Codex 请求失败 (${message.error.code})`), { rpcCode: message.error.code, writerBusy: /active writer/.test(message.error.message || '') }));
        else request.resolve(message.result);
      }
    });

    this.ready = this.request('initialize', {
      clientInfo: { name: 'codex_weixin', title: 'Codex Weixin', version: '0.4.0' },
      capabilities: { experimentalApi: true },
    }).then(() => this.#write({ method: 'initialized' }));
  }

  request(method, params, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const settle = callback => value => {
        clearTimeout(timer);
        this.#pending.delete(id);
        callback(value);
      };
      const timer = timeout > 0
        ? setTimeout(() => this.#pending.get(id)?.reject(new Error(`${method} 超时`)), timeout)
        : undefined;
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.#pending.get(id)?.reject(error);
      }
    });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  reject(id) {
    this.#write({ id, error: { code: -32601, message: 'Unsupported by the Weixin channel' } });
  }

  #write(message) {
    if (!this.#child?.stdin.writable) throw new Error('Codex App Server 未连接');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    this.#child?.kill();
  }
}
