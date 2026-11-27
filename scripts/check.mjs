import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const folder of ['runtime','scripts','test','.']){
 for(const item of await readdir(join(root,folder),{withFileTypes:true})){
  if(item.isFile()&&item.name.endsWith('.mjs'))execFileSync(process.execPath,['--check',join(root,folder,item.name)],{stdio:'inherit'});
 }
}
const pkg=JSON.parse(await readFile(join(root,'package.json')));
const lock=JSON.parse(await readFile(join(root,'package-lock.json')));
const manifest=JSON.parse(await readFile(join(root,'.codex-plugin/plugin.json')));
if(pkg.version!==lock.version||pkg.version!==lock.packages[''].version||pkg.version!==manifest.version)throw Error('版本号不一致');
const mcp=JSON.parse(await readFile(join(root,'.mcp.json')));
if(mcp.mcpServers['weixin-settings'].command!=='node'||!mcp.mcpServers['weixin-settings'].args[0].startsWith('${PLUGIN_ROOT}/'))throw Error('源码 MCP 配置必须可移植');
for(const file of ['runtime/settings.html','runtime/history.html']){
 const html=await readFile(join(root,file),'utf8');
 for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new (await import('node:vm')).Script(script[1]);
}
console.log('源码语法、界面脚本、版本和可移植配置检查通过。');
