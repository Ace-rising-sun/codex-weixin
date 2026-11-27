import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { home } from './store.mjs';

export function accountKey(account) {
  return account?.owner && account?.bot ? createHash('sha256').update(JSON.stringify([account.owner, account.bot])).digest('hex') : null;
}
export function taskId(key, messageId, jobs = []) {
  const digest = createHash('sha256').update(JSON.stringify([key, messageId])).digest('hex').toUpperCase();
  for (let length = 8; length <= digest.length; length += 2) {
    const id = 'T' + digest.slice(0, length);
    if (!jobs.some(job => job.taskId === id && (job.id !== messageId || job.accountKey !== key))) return id;
  }
  throw new Error('任务编号冲突，请重新发送');
}
export function findTask(state, key, id) {
  return state.inbox.find(job => job.accountKey === key && job.taskId === String(id).toUpperCase());
}
export function taskState(job) {
  if (job.status === 'pending') return '排队中';
  if (job.status === 'running') return ({ media: '媒体处理中', approval: '等待审批', executing: '执行中', preparing: '结果附件准备中' })[job.stage] || '执行中';
  const execution = job.status === 'failed' ? '执行失败' : job.status === 'interrupted' ? '已停止或中断' : '结果已生成';
  return execution + ' · ' + ({ pending: '等待回传', sending: '回传中', sent: '已提交发送', partial: '部分附件未送达或未确认', unknown: '投递未确认', failed: '回传失败' })[job.delivery || 'unknown'];
}
export async function attachmentState(output) {
  try {
    const path = await realpath(output.path);
    const root = join(await realpath(home), 'media');
    const inside = relative(root, path);
    if (inside.startsWith('..') || isAbsolute(inside)) return '不可用';
    await access(path);
    return '可重发';
  } catch { return '已过期或缺失'; }
}
export function recoverTasks(state, key) {
  state.outbox ||= [];
  for (const job of state.inbox) {
    job.accountKey ||= key;
    job.taskId ||= taskId(job.accountKey, job.id, state.inbox);
    if (job.status === 'running') { job.status = 'interrupted'; job.stage = 'done'; }
    if (job.receipt === 'sending') job.receipt = 'unknown';
    if (job.delivery === 'sending' || (job.result && !job.delivery)) job.delivery = 'unknown';
    for (const output of job.outputs || []) if (output.delivery === 'sending') output.delivery = 'unknown';
  }
  for (const entry of state.outbox) {
    if (entry.status !== 'sending') continue;
    entry.status = 'unknown';
    for (const part of [...entry.parts, ...entry.outputs]) if (part.delivery === 'sending') part.delivery = 'unknown';
    const job = findTask(state, entry.accountKey, entry.taskId);
    if (entry.kind === 'initial' && job) { job.delivery = 'unknown'; job.stage = 'done'; }
  }
}
