import { randomUUID } from 'node:crypto';
import { sendOutput } from './media-flow.mjs';
import { splitText } from './weixin.mjs';
import { attachmentState, findTask } from './tasks.mjs';

// The state owner persists admission together with the task result before starting drain().
export function queueResult(state, job, { kind = 'initial', indexes = [] } = {}) {
  const outputs = kind === 'initial' ? job.outputs || [] : indexes.map(index => job.outputs[index]);
  const entry = { id: randomUUID(), taskId: job.taskId, accountKey: job.accountKey, kind, status: 'pending', createdAt: Date.now(),
    outputs: outputs.map(output => ({ ...output, delivery: 'pending' })),
    parts: splitText(kind === 'initial' ? job.result : '已按你的明确请求再次发送附件。').map(text => ({ text, delivery: 'pending' })) };
  state.outbox.push(entry);
  return entry;
}
export class Outbox {
  running = false;
  current = null;
  stopped = false;
  constructor({ state, client, key, context, persist, receipt, onError }) { Object.assign(this, { state, client, key, context, persist, receipt, onError }); }
  busy() { return this.running || this.state().outbox.some(entry => entry.accountKey === this.key() && entry.status === 'pending'); }
  async drain() {
    if (this.running || this.stopped || !this.key()) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const entry = this.state().outbox.find(item => item.accountKey === this.key() && item.status === 'pending');
        if (!entry) break;
        const job = findTask(this.state(), entry.accountKey, entry.taskId);
        if (!job) { entry.status = 'failed'; await this.persist(); continue; }
        const controller = new AbortController(); this.current = { entry, job, controller };
        entry.status = 'sending';
        if (entry.kind === 'initial') { job.delivery = 'sending'; job.stage = 'delivering'; }
        await this.persist();
        await this.receipt(job.id);
        const errors = [];
        for (const [index, output] of entry.outputs.entries()) {
          controller.signal.throwIfAborted();
          try {
            const available = await attachmentState(output);
            if (available !== '可重发') throw new Error(available);
            await sendOutput(this.client(), { ...job, context: this.context(job) }, output, (job.maxMediaMb || 20) * 1024 * 1024, controller.signal, async () => { output.delivery = 'sending'; await this.persist(); });
            output.delivery = 'sent';
          } catch (error) {
            output.delivery = output.delivery === 'sending' ? 'unknown' : 'failed';
            output.error = error.message === '已过期或缺失' || error.message === '不可用' ? error.message : '附件发送失败或投递未确认';
            errors.push(`附件 ${index + 1}：${output.error}。可在插件任务记录中查看。`);
          }
          if (entry.kind === 'initial') Object.assign(job.outputs[index], { delivery: output.delivery, error: output.error });
          await this.persist();
        }
        if (errors.length) entry.parts.push(...splitText(errors.join('\n')).map(text => ({ text, delivery: 'pending' })));
        // All text and attachment statuses are durable before their irreversible submissions.
        await this.persist();
        for (const part of entry.parts) {
          controller.signal.throwIfAborted();
          part.delivery = 'sending'; await this.persist();
          try {
            await this.client().sendItem(job.sender, this.context(job), { type: 1, text_item: { text: part.text } }, controller.signal);
            part.delivery = 'sent';
          } catch {
            part.delivery = 'unknown';
            this.onError('结果投递未确认，可用 /result 编号 取回文字；不会自动重发。');
            await this.persist(); break;
          }
          await this.persist();
        }
        entry.status = entry.parts.some(part => part.delivery === 'unknown') ? 'unknown' : entry.outputs.some(output => output.delivery !== 'sent') ? 'partial' : 'sent';
        entry.finishedAt = Date.now();
        if (entry.kind === 'initial') { job.delivery = entry.status; job.deliveredAt = Date.now(); job.stage = 'done'; }
        await this.persist(); this.current = null;
      }
    } catch {
      if (this.current) {
        const { entry, job } = this.current;
        entry.status = 'unknown';
        if (entry.kind === 'initial') job.delivery = 'unknown';
        await this.persist().catch(() => {});
      }
      this.onError('回传已暂停，投递未确认的结果不会自动重发。');
    } finally { this.current = null; this.running = false; }
  }
  abort() {
    this.stopped = true;
    if (!this.current) return;
    const { entry, job, controller } = this.current;
    controller.abort(); entry.status = 'unknown';
    for (const item of [...entry.parts, ...entry.outputs]) if (item.delivery === 'sending') item.delivery = 'unknown';
    if (entry.kind === 'initial') job.delivery = 'unknown';
  }
}
