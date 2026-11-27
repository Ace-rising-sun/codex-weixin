import test from 'node:test';
import assert from 'node:assert/strict';
import { listHistory } from '../runtime/history.mjs';

test('history preserves legacy entries, sorts recent activity and identifies active conversation', () => {
  const state = {
    thread: 'current',
    history: [
      { id: 'old', title: '旧会话', workspace: '/old', createdAt: 100 },
      { id: 'current', title: '当前会话', workspace: '/current', createdAt: 80 },
    ],
    inbox: [
      { threadId: 'current', createdAt: 110, finishedAt: 120, text: '最近任务' },
      { createdAt: 130, text: '无会话关联的旧任务', context: 'secret' },
    ],
  };
  const result = listHistory(state, 'current');
  assert.equal(result.history[0].id, 'current');
  assert.equal(result.history[0].updatedAt, 120);
  assert.equal(result.history[0].current, true);
  assert.equal(result.history[0].running, true);
  assert.equal(result.history[0].preview, '最近任务');
  assert.equal(result.history[1].updatedAt, null);
  assert.equal(result.history[1].createdAt, 100);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('empty history and old entries without timestamps remain readable', () => {
  assert.deepEqual(listHistory({}), { history: [] });
  const result = listHistory({ history: [{ id: 'legacy' }], inbox: [] });
  assert.equal(result.history[0].title, '微信会话');
  assert.equal(result.history[0].createdAt, null);
  assert.equal(result.history[0].updatedAt, null);
});
