import { fileURLToPath } from 'node:url';
import { testControl } from './support.mjs';
import { encode } from 'silk-wasm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { convert, wavFromPcm } from '../runtime/audio-video.mjs';
import { encrypt } from '../runtime/media.mjs';
import { defaults } from '../runtime/store.mjs';
const status=home=>testControl(home,'status');
test('normal bridge accepts four media kinds, feeds Codex and sends four encrypted outputs', {timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'wx-media-e2e-'));const output=join(root,'sent');const turns=join(root,'turns');const home=join(root,'private');await mkdir(home);
 const file=join(root,'report.txt');await writeFile(file,'report');const image=join(root,'picture.png');const video=join(root,'movie.mp4');const wav=join(root,'voice.wav');
 await writeFile(wav,wavFromPcm(Buffer.alloc(24000*2)));await convert(['-f','lavfi','-i','color=c=red:s=32x32:d=1','-frames:v','1','-y',image]);await convert(['-f','lavfi','-i','color=c=green:s=32x32:d=1','-c:v','libx264','-pix_fmt','yuv420p','-y',video]);
 const silk=await encode(await readFile(wav),0);const key=Buffer.alloc(16,7);const reference={full_url:'https://novac2c.cdn.weixin.qq.com/c2c/data',aes_key:key.toString('base64')};
 const bytes={image:(await readFile(image)).toString('base64'),video:(await readFile(video)).toString('base64'),voice:Buffer.from(silk.data).toString('base64'),file:Buffer.from('uploaded report').toString('base64')};
 const encrypted={};for(const [kind,value] of Object.entries(bytes))encrypted[kind]=encrypt(Buffer.from(value,'base64'),key).toString('base64');
 const item=(type,field,kind,more={})=>({type,[field]:{media:{...reference,full_url:reference.full_url+'/'+kind},...more}});
 const inbound={message_type:1,message_id:'media-1',from_user_id:'owner',context_token:'context',item_list:[{type:1,text_item:{text:'请分析并发回附件'}},item(2,'image_item','image'),item(3,'voice_item','voice',{text:'测试语音指令'}),item(4,'file_item','file',{file_name:'report.txt'}),item(5,'video_item','video')]};
 const responses=[{path:file,kind:'file'},{path:image,kind:'image'},{path:wav,kind:'voice'},{path:video,kind:'video'}];
 const answer='分析完成。\n'+responses.map(data=>'WEIXIN_MEDIA: '+JSON.stringify(data)).join('\n');
 const fake=join(root,'agent.cjs');await writeFile(fake,`const fs=require('fs');const {createInterface}=require('readline');const out=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='thread/start')result={thread:{id:'00000000-0000-0000-0000-000000000002'}};if(m.method==='turn/start'){fs.writeFileSync(${JSON.stringify(turns)},JSON.stringify(m.params));result={turn:{id:'turn'}};setTimeout(()=>{out({method:'item/completed',params:{threadId:m.params.threadId,turnId:'turn',item:{type:'agentMessage',text:${JSON.stringify(answer)}}}});out({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn',status:'completed'}}});},20);}out({id:m.id,result});});`);
 const preload=join(root,'network.mjs');await writeFile(preload,`import {appendFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';const payloads=${JSON.stringify(encrypted)};globalThis.fetch=async(url,opts)=>{if(url.includes('/data/'))return new Response(Buffer.from(payloads[url.split('/').pop()],'base64'));if(url.includes('/upload'))return new Response('',{headers:{'x-encrypted-param':'download'}});const body=JSON.parse(opts.body);if(url.includes('getupdates')){await delay(30);return Response.json({ret:0,msgs:body.get_updates_buf?[]:[${JSON.stringify(inbound)}],get_updates_buf:'1'});}if(url.includes('getuploadurl'))return Response.json({ret:0,upload_full_url:'https://novac2c.cdn.weixin.qq.com/c2c/upload'});if(url.includes('sendmessage')){await appendFile(${JSON.stringify(output)},JSON.stringify(body.msg)+'\\n');return Response.json({ret:0});}throw Error('unexpected URL');};`);
 await writeFile(join(home,'account.json'),JSON.stringify({token:'private',owner:'owner',bot:'bot',baseurl:'https://ilinkai.weixin.qq.com'}));await writeFile(join(home,'settings.json'),JSON.stringify({...defaults,workspace:root}));
 const child=spawn(process.execPath,['--import',preload,fileURLToPath(new URL('../runtime/daemon.mjs',import.meta.url))],{env:{...process.env,CODEX_WEIXIN_HOME:home,CODEX_WEIXIN_CODEX:fake},stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',data=>log+=data);
 try{
  let value;for(let i=0;i<250;i++){try{value=await status(home);if(value.tasks[0]?.delivery==='sent')break;}catch{}await delay(40);}
  assert.equal(value?.tasks[0]?.delivery,'sent',JSON.stringify(value?.tasks)+' '+log);
  assert.equal(value.tasks[0].outputs.length,4);assert.ok(value.tasks[0].outputs.every(x=>x.delivery==='sent'));
  const input=JSON.parse(await readFile(turns));assert.ok(input.input.filter(x=>x.type==='localImage').length>=7);assert.ok(input.input.some(x=>x.text?.includes('测试语音指令')));
  const delivered=(await readFile(output,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(delivered.every(x=>x.to_user_id==='owner'));assert.deepEqual(delivered.filter(x=>x.item_list[0].type!==1).map(x=>x.item_list[0].type),[4,2,4,5]);
  assert.ok(!delivered.some(x=>JSON.stringify(x).includes('WEIXIN_MEDIA')));
 }finally{if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit;}await rm(root,{recursive:true,force:true});}
});
