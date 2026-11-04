const fs=require('fs'), path=require('path'), crypto=require('crypto'), {spawn}=require('child_process');
const root=__dirname, fixture='/home/coder/locks-pnpm10/.moderne/lock-fixtures';
const {ensureCa,startRegistry}=require(fixture+'/record/sweep/pnpm-registry.js');
const evidence='/home/coder/locks-pnpm10/language-tools-evidence/results/broad-source/vuejs__language-tools/vuejs__language-tools';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(d,x.name)):[path.join(d,x.name)]);
const snapshot=()=>Object.fromEntries(walk(root+'/registry').filter(f=>f.includes('/_overlay/')||f.includes('/_live/')).sort().map(f=>[path.relative(root+'/registry',f),sha(fs.readFileSync(f))]));
const run=(args,cwd,env,log)=>new Promise(resolve=>{const fd=fs.openSync(log,'w');const p=spawn(process.execPath,['/tmp/pnpm-upstream/pm/11.9.0/package/bin/pnpm.cjs',...args],{cwd,env,stdio:['ignore',fd,fd]});p.on('exit',code=>{fs.closeSync(fd);resolve(code)})});
(async()=>{
fs.mkdirSync(root+'/scenario',{recursive:true});fs.mkdirSync(root+'/registry',{recursive:true});
const ca=ensureCa(root+'/registry/_ca'), log={requests:[],overlay:new Set(),live:new Set(),pmMetadata:new Set(),pmRefused:new Set()};
global.fetch=async (url)=>{throw new Error('UNRECORDED NETWORK BLOCKED '+url)};
const at='2026-11-04T00:40:00Z';const server=await startRegistry({scenarioDir:root+'/scenario',scenario:'language-tools',shared:root+'/registry',at,ca,log});
const results=[];
try {
for(const name of ['edited-full-warm']) {
 const dir=root+'/baseline-full-cold';
 if(name.startsWith('edited'))for(const s of JSON.parse(fs.readFileSync(evidence+'/recipe/selections.json'))){if(s.scope==='peerDependencies')continue;const f=dir+'/project/'+s.file;const p=JSON.parse(fs.readFileSync(f));p[s.scope][s.name]=s.target;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');}
 const before=fs.readFileSync(dir+'/project/pnpm-lock.yaml');const proxy=`http://127.0.0.1:${server.port}`;
 const env={...process.env,HOME:dir+'/home',XDG_CONFIG_HOME:dir+'/home/.config',XDG_CACHE_HOME:dir+'/home/.cache',XDG_DATA_HOME:dir+'/home/.local/share',XDG_STATE_HOME:dir+'/home/.state',npm_config_userconfig:'/dev/null',pnpm_config_userconfig:'/dev/null',pnpm_config_npmrc_auth_file:'/dev/null',pnpm_config_update_notifier:'false',CI:'true',HTTPS_PROXY:proxy,https_proxy:proxy,HTTP_PROXY:proxy,http_proxy:proxy,NO_PROXY:'',no_proxy:'',NODE_EXTRA_CA_CERTS:ca.caFile};
 delete env.NODE_OPTIONS;delete env.PNPM_HOME;
 log.requests.push('# '+name);const code=await run(['install','--no-frozen-lockfile','--ignore-scripts','--store-dir='+dir+'/store','--cache-dir='+dir+'/cache'],dir+'/project',env,root+'/warm-native.log');
 const after=fs.readFileSync(dir+'/project/pnpm-lock.yaml');const cli=after.toString().match(/'@lerna-lite\/cli':\n\s+specifier: latest\n\s+version: ([^\n]+)/)?.[1];
 const result={name,exit:code,cli,beforeSha256:sha(before),afterSha256:sha(after),registrySnapshot:snapshot()};results.push(result);fs.writeFileSync(root+'/warm-full-results.json',JSON.stringify({pnpm:'11.9.0',at,results},null,2)+'\n');fs.writeFileSync(root+'/warm-full-requests.log',log.requests.join('\n')+'\n');console.log(JSON.stringify({name,code,cli,lockHash:sha(after),registryDocuments:Object.keys(result.registrySnapshot).length}));
 if(code!==0)break;
}
}finally {server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
