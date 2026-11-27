export function listHistory(state, runningThreadId) {
  const activity = new Map();
  for (const job of state.inbox || []) {
    if (!job.threadId) continue;
    const previous = activity.get(job.threadId);
    const time = job.finishedAt || job.createdAt || 0;
    if (!previous || time >= previous.time) {
      activity.set(job.threadId, { time, preview: job.text || job.attachments?.find(item => item.transcript)?.transcript || '媒体任务' });
    }
  }
  const history = (state.history || []).map(entry => {
    const task = activity.get(entry.id);
    return {
      id: entry.id,
      title: entry.title || '微信会话',
      workspace: entry.workspace || '',
      createdAt: entry.createdAt || null,
      updatedAt: Math.max(entry.updatedAt || 0, task?.time || 0) || null,
      preview: task?.preview?.slice(0, 180) || '',
      current: entry.id === state.thread,
      running: entry.id === runningThreadId,
    };
  });
  history.sort((first, second) => (second.updatedAt || second.createdAt || 0) - (first.updatedAt || first.createdAt || 0));
  return { history };
}
