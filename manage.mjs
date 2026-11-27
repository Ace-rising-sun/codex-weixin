import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { control } from './runtime/control.mjs';
import { startService, stopService, removeService } from './runtime/service.mjs';
import { codexExecutable } from './runtime/platform.mjs';
async function manage(action){
 if(action==='status'){const status=await control('status');console.log(JSON.stringify({connected:status.connected,bound:status.bound,running:Boolean(status.current),pending:status.tasks.filter(item=>item.status==='pending').length},null,2));return;}
 if(['stop','uninstall'].includes(action)){
  const status=await control('status').catch(error=>{if(['ENOENT','ECONNREFUSED'].includes(error.code))return null;throw error;});
  if(status&&(status.current||status.tasks.some(item=>item.status==='pending')))throw new Error('请先在微信 /stop 并等待任务结束后再停止后台');
 }
 if(action==='start')await startService();
 else if(action==='stop')await stopService();
 else if(action==='uninstall'){
  await removeService();
  const codex=codexExecutable();
  execFileSync(codex,['plugin','remove','codex-weixin@weixin-local'],{stdio:'inherit',windowsHide:true});
  execFileSync(codex,['plugin','marketplace','remove','weixin-local'],{stdio:'inherit',windowsHide:true});
  console.log('插件和自启动后台已卸载。用户绑定、设置、历史和模型缓存保留在私有数据目录。');
 }else throw new Error('用法：node manage.mjs start|stop|status|uninstall');
}
manage(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
