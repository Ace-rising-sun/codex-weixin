import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { home, read, save } from './store.mjs';
import { isWindows, powershellSync } from './platform.mjs';
const standardHome=join(homedir(),'Library','Application Support','Codex Weixin');
const label = home===standardHome ? 'local.codex-weixin' : 'local.codex-weixin.' + createHash('sha256').update(home).digest('hex').slice(0,16);
const domain = !isWindows ? `gui/${process.getuid()}` : null;
const plist = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
const task = 'Codex Weixin ' + createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0,16);
function windows(action, config = {}) {
  const script = {
    state: '$task = Get-ScheduledTask -TaskName $env:WX_TASK_NAME -ErrorAction SilentlyContinue; if ($task) { [string]$task.State }',
    start: 'Start-ScheduledTask -TaskName $env:WX_TASK_NAME',
    stop: 'Stop-ScheduledTask -TaskName $env:WX_TASK_NAME',
    remove: 'Unregister-ScheduledTask -TaskName $env:WX_TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue',
    register: `$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:WX_TASK_NODE -Argument ('"' + $env:WX_TASK_ENTRY + '" --home "' + $env:WX_TASK_HOME + '"') -WorkingDirectory $env:WX_TASK_ROOT
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $env:WX_TASK_NAME -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  }[action];
  return powershellSync(script, { WX_TASK_NAME: task, WX_TASK_NODE: config.node || '', WX_TASK_ENTRY: config.entry || '', WX_TASK_ROOT: config.root || '', WX_TASK_HOME: home });
}
export function serviceLoaded() {
  if (isWindows) return Boolean(windows('state'));
  try { execFileSync('/bin/launchctl', ['print', domain + '/' + label], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
export async function stopService() {
  if (isWindows) { if (serviceLoaded()) windows('stop'); }
  else if (serviceLoaded()) execFileSync('/bin/launchctl', ['bootout', domain + '/' + label]);
  // Wait for the owning PID to leave before a replacement can use its socket and state.
  const lock = join(home, 'daemon.lock');
  for (let attempt=0; attempt<100; attempt++) {
    let pid;
    try { pid = Number(await readFile(lock,'utf8')); } catch(error) { if(error.code==='ENOENT') return; throw error; }
    try { process.kill(pid,0); } catch(error) { if(error.code==='ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error('后台尚未退出，请稍后重试');
}
export async function startService() {
  const config = await read('service', null);
  if (!config) throw new Error('请先运行安装程序');
  if (isWindows) { windows('start'); return; }
  if (serviceLoaded()) execFileSync('/bin/launchctl', ['kickstart', domain + '/' + label]);
  else execFileSync('/bin/launchctl', ['bootstrap', domain, plist]);
}
export async function registerService(config) {
  await mkdir(home,{recursive:true,mode:0o700});
  await save('service', config);
  if (isWindows) { windows('register',config); windows('start'); return; }
  const xml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  await mkdir(dirname(plist),{recursive:true});
  const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(config.node)}</string><string>${xml(config.entry)}</string></array><key>WorkingDirectory</key><string>${xml(config.root)}</string><key>EnvironmentVariables</key><dict><key>CODEX_WEIXIN_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(home,'daemon.log'))}</string><key>StandardErrorPath</key><string>${xml(join(home,'daemon.log'))}</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>`;
  await writeFile(plist,content,{mode:0o600});
  execFileSync('/usr/bin/plutil',['-lint',plist],{stdio:'ignore'});
  for(let attempt=0;attempt<3;attempt++){
    try { execFileSync('/bin/launchctl',['bootstrap',domain,plist],{stdio:'pipe'});return; }
    catch(error){if(serviceLoaded())return;if(attempt===2)throw error;await delay(500);}
  }
}
export async function removeService() {
  await stopService();
  if(isWindows)windows('remove');
  else await rm(plist,{force:true});
}
