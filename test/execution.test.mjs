import { fileURLToPath, pathToFileURL } from 'node:url';
import { testControl } from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const origin = fileURLToPath(new URL('../', import.meta.url));
const call=testControl;
test('queued tasks continue after active turn and interruption targets current turn', {timeout:15000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wx-exec-'));
 const fake=join(dir,'fake.cjs');const preload=join(dir,'transport.mjs');
 await writeFile(fake, `const {createInterface}=require('node:readline');let timer;const send=x=>console.log(JSON.stringify(x));const event=(method,params)=>send({method,params});createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='thread/start')result={thread:{id:'00000000-0000-0000-0000-000000000001'}};if(m.method==='turn/start'){const id=m.params.input[0].text;result={turn:{id}};event('turn/started',{threadId:m.params.threadId,turn:{id}});timer=setTimeout(()=>{event('item/completed',{threadId:m.params.threadId,turnId:id,item:{type:'agentMessage',text:'result '+id}});event('turn/completed',{threadId:m.params.threadId,turn:{id,status:'completed'}})},600);}if(m.method==='turn/interrupt'){clearTimeout(timer);event('turn/completed',{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted'}});}send({id:m.id,result});});`);
 await writeFile(preload, `import {readFile,appendFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);if(url.includes('getupdates')){await delay(40);const messages=JSON.parse(await readFile(process.env.TEST_WX_MESSAGES,'utf8'));const offset=Number(body.get_updates_buf||0);return Response.json({ret:0,msgs:messages.slice(offset),get_updates_buf:String(messages.length)});}if(url.includes('sendmessage')){await appendFile(process.env.TEST_WX_OUTBOX,JSON.stringify(body.msg)+'\\n');return Response.json({ret:0});}throw Error('unexpected request');};`);
 const messages=join(dir,'messages.json');const outbox=join(dir,'outbox');
 const incoming=(id,text,sender='owner')=>({message_type:1,message_id:id,from_user_id:sender,context_token:'ctx',item_list:[{type:1,text_item:{text}}]});
 let input=[incoming('foreign','must ignore','stranger'),incoming('1','first')];
 await writeFile(messages,JSON.stringify(input));await writeFile(outbox,'');
 await writeFile(join(dir,'account.json'),JSON.stringify({token:'test',owner:'owner',bot:'bot',baseurl:'https://ilinkai.weixin.qq.com'}));
 const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,join(origin,'runtime/daemon.mjs')],{env:{...process.env,CODEX_WEIXIN_HOME:dir,CODEX_WEIXIN_CODEX:fake,TEST_WX_MESSAGES:messages,TEST_WX_OUTBOX:outbox},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',x=>logs+=x);
 const status=()=>call(dir,'status');
 async function until(predicate){for(let i=0;i<150;i++){try{const value=await status();if(predicate(value))return value;}catch{}await delay(30);}throw Error(logs);}
 try{
  await until(s=>s.current?.title==='first');
  input.push(incoming('2','second'));await writeFile(messages,JSON.stringify(input));
  let value=await until(s=>s.tasks.length===2&&s.tasks.every(x=>x.delivery==='sent'));
  assert.deepEqual(value.tasks.map(x=>x.result),['result second','result first']);
  assert.deepEqual(value.account,{userId:'owner',botId:'bot'});
  assert.equal(Object.hasOwn(value.account,'token'),false);
  input.push(incoming('3','third'));await writeFile(messages,JSON.stringify(input));
  await until(s=>s.current?.title==='third');await call(dir,'stop');
  value=await until(s=>s.tasks[0]?.delivery==='sent'&&!s.busy);
  assert.equal(value.tasks[0].result,'本轮任务已停止。');
  const sent=(await readFile(outbox,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(sent.every(x=>x.to_user_id==='owner'));assert.ok(!sent.some(x=>JSON.stringify(x).includes('must ignore')));
  const disk=JSON.parse(await readFile(join(dir,'state.json')));assert.equal(disk.cursor,'4');
  const loggedOut=await call(dir,'logout');
  assert.equal(loggedOut.account,null);
  assert.equal(loggedOut.bound,false);
 }finally{if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit;}await rm(dir,{recursive:true,force:true});}
});
