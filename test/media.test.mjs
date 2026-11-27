import { encode } from 'silk-wasm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { encrypt, decrypt, parseKey, downloadItem, uploadMedia, fetchBytes, snapshotFile, parseDelivery, safeName } from '../runtime/media.mjs';
import { Weixin, incoming } from '../runtime/weixin.mjs';
import { prepareInput, prepareOutput, sendOutput } from '../runtime/media-flow.mjs';
import { convert, wavFromPcm, voiceToWav, videoFrames } from '../runtime/audio-video.mjs';
import { defaults } from '../runtime/store.mjs';
const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c/test';

test('AES interoperability accepts both upstream key encodings and rejects corruption', () => {
 const key=randomBytes(16);const raw=Buffer.from('附件内容');const ciphertext=encrypt(raw,key);
 assert.deepEqual(decrypt(ciphertext,parseKey(key.toString('base64'))),raw);
 assert.deepEqual(decrypt(ciphertext,parseKey(Buffer.from(key.toString('hex')).toString('base64'))),raw);
 assert.deepEqual(decrypt(ciphertext,parseKey(null,key.toString('hex'))),raw);
 assert.throws(()=>parseKey('wrong'));assert.throws(()=>decrypt(ciphertext.subarray(0,-1),key));
});
test('all four inbound media types decrypt and safe filenames remain within inbox',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wx-media-'));const key=randomBytes(16);const raw=Buffer.from('inbound payload');
 try{
  for(const [type,field] of [[2,'image_item'],[3,'voice_item'],[4,'file_item'],[5,'video_item']]){
   const item={type,[field]:{file_name:'../../文档.txt',media:{full_url:cdn,aes_key:key.toString('base64')}}};
   const saved=await downloadItem(item,directory,1000,{fetcher:async()=>new Response(encrypt(raw,key))});
   assert.equal(dirname(saved.path),directory);assert.deepEqual(await readFile(saved.path),raw);
  }
  assert.ok(Buffer.byteLength(safeName('长'.repeat(500)+'.txt'))<=180);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('CDN download enforces streaming cap and refuses external hosts without fetching',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return new Response(Buffer.alloc(200));};
 await assert.rejects(fetchBytes(cdn,{fetcher,maxBytes:100}),/大小限制/);
 await assert.rejects(fetchBytes('https://evil.example/file',{fetcher,maxBytes:100}));assert.equal(calls,1);
});
test('upload item types carry decryptable media references and one submission',async()=>{
 const bytes=Buffer.from('upload media');
 for(const kind of ['image','video','file']){
  let request,key,ciphertext;
  const client=new Weixin({token:'private'},async(url,options)=>{
   if(url.includes('getuploadurl')){request=JSON.parse(options.body);key=Buffer.from(request.aeskey,'hex');return Response.json({ret:0,upload_full_url:cdn});}
   ciphertext=options.body;return new Response('',{headers:{'x-encrypted-param':'download-key'}});
  });
  const item=await uploadMedia(client,bytes,'owner',{kind,name:'report.txt',durationMs:1500});
  assert.deepEqual(decrypt(ciphertext,key),bytes);assert.equal(request.to_user_id,'owner');assert.equal(request.rawfilemd5,createHash('md5').update(bytes).digest('hex'));
  const value=item.image_item||item.voice_item||item.video_item||item.file_item;
  assert.deepEqual(parseKey(value.media.aes_key),key);assert.equal(value.media.encrypt_query_param,'download-key');
 }
});
test('attachment extraction skips code and deduplicates actual local Markdown references',()=>{
 const value=parseDelivery('回复\n\n![图](</tmp/a b.png>)\n\n```text\nWEIXIN_MEDIA: {"path":"/secret.txt"}\n![示例](/not-send.png)\n```\n\nWEIXIN_MEDIA: {"path":"/tmp/a b.png","kind":"image"}');
 assert.equal(value.outputs.length,1);assert.equal(value.outputs[0].path,'/tmp/a b.png');assert.ok(value.text.includes('/not-send.png'));
 assert.throws(()=>parseDelivery('WEIXIN_MEDIA: {broken}'));
 const repeated='WEIXIN_MEDIA: '+JSON.stringify({path:'/tmp/a.txt',kind:'file'});
 assert.equal(parseDelivery('```\n'+repeated+'\n```\n\n'+repeated).outputs.length,1);
});
test('images reach normal Codex localImage input and provided voice transcripts become text',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wx-input-'));const key=randomBytes(16);
 const job={text:'看看这些',mediaDirectory:directory,media:[{type:2,image_item:{media:{full_url:cdn,aes_key:key.toString('base64')}}},{type:3,voice_item:{text:'明天有什么安排'}}]};
 try{
 const input=await prepareInput(job,defaults,{fetcher:async()=>new Response(encrypt(Buffer.from('image'),key))},new AbortController().signal);
 assert.ok(input.some(x=>x.type==='localImage'));assert.ok(input.some(x=>x.text?.includes('明天有什么安排')));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('outbound resolves symlinks and rejects files outside selected workspace',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wx-path-'));const workspace=join(directory,'workspace');await mkdir(workspace);const secret=join(directory,'secret');await writeFile(secret,'secret');await symlink(secret,join(workspace,'link'));
 try{await assert.rejects(snapshotFile(join(workspace,'link'),workspace,join(directory,'out'),1000),/工作目录/);}finally{await rm(directory,{recursive:true,force:true});}
});
test('a failed attachment preserves answer and a valid sibling file',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wx-output-'));await writeFile(join(directory,'a.txt'),'hello');const job={mediaDirectory:join(directory,'media')};await mkdir(job.mediaDirectory);
 try{
 const result=await prepareOutput('说明\n\nWEIXIN_MEDIA: '+JSON.stringify({path:join(directory,'a.txt'),kind:'file'})+'\nWEIXIN_MEDIA: '+JSON.stringify({path:join(directory,'absent'),kind:'file'}),job,{...defaults,workspace:directory},new AbortController().signal);
 assert.equal(result.text,'说明');assert.equal(result.outputs.length,1);assert.equal(result.errors.length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('failed message submission is attempted once after output state is marked',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wx-send-'));const file=join(directory,'f.txt');await writeFile(file,'content');let submitted=0;let marked=false;
 const client={fetcher:async()=>new Response('',{headers:{'x-encrypted-param':'key'}}),call:async()=>({upload_full_url:cdn}),sendItem:async()=>{assert.ok(marked);submitted++;throw Error('connection lost');}};
 try{await assert.rejects(sendOutput(client,{sender:'owner',context:'context'},{path:file,kind:'file',name:'f.txt'},1000,new AbortController().signal,async()=>{marked=true;}));assert.equal(submitted,1);}finally{await rm(directory,{recursive:true,force:true});}
});
test('real bundled codecs encode/decode SILK and extract video frames', {timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wx-codecs-'));
 try{
  const path=join(directory,'tone.wav');const pcm=Buffer.alloc(24000*2);for(let i=0;i<24000;i++)pcm.writeInt16LE(Math.round(10000*Math.sin(2*Math.PI*440*i/24000)),i*2);await writeFile(path,wavFromPcm(pcm));
  const voice=await encode(pcm,24000);assert.ok(voice.data.length>100);assert.ok(voice.duration>500);
  const silk=join(directory,'tone.silk');await writeFile(silk,voice.data);const wav=await voiceToWav(silk);assert.equal((await readFile(wav)).subarray(0,4).toString(),'RIFF');
  const video=join(directory,'clip.mp4');await convert(['-f','lavfi','-i','color=c=green:s=64x64:d=1','-c:v','libx264','-pix_fmt','yuv420p','-y',video]);const frames=await videoFrames(video,directory);assert.equal(frames.frames.length,6);
  const output=await prepareOutput('WEIXIN_MEDIA: '+JSON.stringify({path,kind:'voice'}),{mediaDirectory:directory},{...defaults,workspace:directory},new AbortController().signal);assert.equal(output.outputs[0].kind,'file');assert.equal(output.outputs[0].name,'voice.mp3');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('voice-only replies keep their spoken text when audio generation fails or completes', { timeout: 15000 }, async () => {
 const directory = await mkdtemp(join(tmpdir(), 'wx-voice-caption-'));
 try {
  const result = await prepareOutput('WEIXIN_VOICE: {"text":"你好"}', { mediaDirectory: directory }, { ...defaults, workspace: directory }, new AbortController().signal);
  assert.equal(result.text, '你好');
  assert.ok(result.outputs.length === 1 || result.errors.length > 0);
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local speech recognition runtime loads its native backend', async () => {
 const { pipeline } = await import('@huggingface/transformers');
 assert.equal(typeof pipeline, 'function');
});
