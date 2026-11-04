// Replays the real PNPM 11.9 cold/warm comparison against the captured registry metadata.
// node replay.cjs /absolute/path/to/pnpm.cjs /absolute/output/directory
// Optional SWEEP_OPENSSL overrides OpenSSL; openssl-current-time.py adapts OpenSSL 3.0 for a current-clock replay.
const fs=require('fs'),path=require('path'),os=require('os'),zlib=require('zlib'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');
const {ensureCa,startRegistry}=require('../../../record/sweep/pnpm-registry.js');
const [pm,out]=process.argv.slice(2);if(!pm||!out)throw Error('usage: node replay.cjs /absolute/pnpm.cjs /absolute/output');
if(execFileSync(process.execPath,[pm,'--version'],{encoding:'utf8'}).trim()!=='11.9.0')throw Error('requires actual PNPM 11.9.0');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(d,x.name)):[path.join(d,x.name)]);
const run=(args,cwd,env,file)=>new Promise(resolve=>{const fd=fs.openSync(file,'w'),p=spawn(process.execPath,[pm,...args],{cwd,env,stdio:['ignore',fd,fd]});p.on('exit',code=>{fs.closeSync(fd);resolve(code)});});
(async()=>{
fs.mkdirSync(out,{recursive:true});const w=fs.mkdtempSync(path.join(os.tmpdir(),'pnpm119-cache-control-')),shared=w+'/registry',scenario=w+'/scenario';fs.mkdirSync(scenario,{recursive:true});
const hashes=JSON.parse(fs.readFileSync(__dirname+'/registry-sha256.json'));
for(const f of walk(__dirname+'/registry')){const rel=path.relative(__dirname+'/registry',f),dest=path.join(shared,'_overlay/language-tools',rel.endsWith('.gz')?rel.slice(0,-3):rel);fs.mkdirSync(path.dirname(dest),{recursive:true});const raw=rel.endsWith('.gz')?zlib.gunzipSync(fs.readFileSync(f)):fs.readFileSync(f);if(rel.endsWith('.gz')&&sha(raw)!==hashes[rel.slice(0,-3)].sha256)throw Error('metadata hash mismatch: '+rel);fs.writeFileSync(dest,raw);}
// Captured metadata is mandatory. Tarballs may be fetched from immutable URLs, integrity-checked by PNPM.
const realFetch=global.fetch;global.fetch=async(url,...args)=>{if(String(url).endsWith('.tgz'))return realFetch(url,...args);throw Error('UNRECORDED METADATA BLOCKED '+url);};
const ca=ensureCa(shared+'/_ca'),log={requests:[],overlay:new Set(),live:new Set(),pmMetadata:new Set(),pmRefused:new Set()};
const server=await startRegistry({scenarioDir:scenario,scenario:'language-tools',shared,at:'2026-11-04T00:40:00Z',ca,log}),results=[];
try{
for(const name of ['baseline','warm-edited','cold-edited','cold-lock-only']){
 const dir=w+'/'+(name==='warm-edited'?'baseline':name),project=dir+'/project';
 if(name!=='warm-edited'){fs.mkdirSync(dir,{recursive:true});fs.cpSync(__dirname+'/baseline',project,{recursive:true});fs.mkdirSync(dir+'/home');}
 if(name!=='baseline')for(const s of JSON.parse(fs.readFileSync(__dirname+'/selections.json'))){if(s.scope==='peerDependencies')continue;const f=project+'/'+s.file,p=JSON.parse(fs.readFileSync(f));p[s.scope][s.name]=s.target;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');}
 const proxy=`http://127.0.0.1:${server.port}`,env={...process.env,HOME:dir+'/home',XDG_CONFIG_HOME:dir+'/home/.config',XDG_CACHE_HOME:dir+'/home/.cache',XDG_DATA_HOME:dir+'/home/.data',XDG_STATE_HOME:dir+'/home/.state',npm_config_userconfig:'/dev/null',pnpm_config_userconfig:'/dev/null',pnpm_config_npmrc_auth_file:'/dev/null',pnpm_config_update_notifier:'false',CI:'true',HTTPS_PROXY:proxy,https_proxy:proxy,HTTP_PROXY:proxy,http_proxy:proxy,NO_PROXY:'',no_proxy:'',NODE_EXTRA_CA_CERTS:ca.caFile};delete env.NODE_OPTIONS;delete env.PNPM_HOME;
 log.requests.push('# '+name);const file=out+'/'+name+'.log';const exit=await run(['install',...(name==='cold-lock-only'?['--lockfile-only']:[]),'--no-frozen-lockfile','--ignore-scripts','--fetch-retries=0','--store-dir='+dir+'/store','--cache-dir='+dir+'/cache'],project,env,file);
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').split(w).join('<tmp>'));
 const lock=fs.readFileSync(project+'/pnpm-lock.yaml');fs.writeFileSync(out+'/'+name+'.yaml',lock);const expected=fs.readFileSync(__dirname+'/'+(name==='baseline'?'baseline/pnpm-lock.yaml':name==='warm-edited'?'warm-native.yaml':'cold-native.yaml'));
 results.push({name,exit,sha256:sha(lock),byteExact:lock.equals(expected)});console.log(results.at(-1));if(exit!==0||!lock.equals(expected))throw Error('native result differs: '+name);
}
fs.writeFileSync(out+'/result.json',JSON.stringify({manager:'11.9.0',results},null,2)+'\n');fs.writeFileSync(out+'/requests.log',log.requests.join('\n')+'\n');
}finally{server.close();fs.rmSync(w,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
