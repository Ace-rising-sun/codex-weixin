import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const pkg=JSON.parse(await readFile(join(root,'package.json')));
const output=join(root,'release');await mkdir(output,{recursive:true});
const stage=await mkdtemp(join(output,'.stage-'));
const name=`codex-weixin-${pkg.version}`;const source=join(stage,name);await mkdir(source);
const entries=['.agents','.codex-plugin','.mcp.json','.gitignore','runtime','skills','test','scripts','docs','package.json','package-lock.json','install.mjs','manage.mjs','LICENSE','README.md','CHANGELOG.md','THIRD-PARTY-NOTICES.md'];
try{
 for(const entry of entries)await cp(join(root,entry),join(source,entry),{recursive:true});
 const filename=name+'.tar.gz';
 execFileSync('tar',['-czf',join(output,filename),'-C',stage,name],{stdio:'inherit'});
 const listing=execFileSync('tar',['-tzf',join(output,filename)],{encoding:'utf8'});
 if(/node_modules|account\.json|state\.json|control\.json|\.env(?:\n|$)/.test(listing))throw Error('发布包包含本机数据');
 if(!listing.includes(name+'/.mcp.json'))throw Error('发布包缺少 MCP 配置');
 const digest=createHash('sha256').update(await readFile(join(output,filename))).digest('hex');
 await writeFile(join(output,'SHA256SUMS'),`${digest}  ${filename}\n`);
 console.log(join(output,filename));
}finally{await rm(stage,{recursive:true,force:true});}
