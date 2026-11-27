import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { home } from './store.mjs';
import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = join(home, 'models');
let recognizer;
parentPort.on('message', async ({ id, path }) => {
  try {
    recognizer ??= await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { dtype: 'q8', device: 'cpu' });
    const pcm = await readFile(path);
    const audio = new Float32Array(pcm.length / 2);
    for (let i = 0; i < audio.length; i++) audio[i] = pcm.readInt16LE(i * 2) / 32768;
    const result = await recognizer(audio, { language: 'chinese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const text = result.text?.trim();
    if (!text) throw new Error('empty');
    parentPort.postMessage({ id, text });
  } catch { recognizer = null; parentPort.postMessage({ id, error: '本地语音识别失败，请检查模型下载网络或改发文字。原始语音已保留。' }); }
});
