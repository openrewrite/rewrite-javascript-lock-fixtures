import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const [mode,id,workArg]=process.argv.slice(2);
if(!['generate','consume'].includes(mode)||!id||!workArg)throw Error('Usage: node run.mjs generate|consume CASE ABSOLUTE_WORK_DIR');
const spec=JSON.parse(fs.readFileSync(path.join(here,'cases.json'))).find(c=>c.id===id);if(!spec)throw Error('Unknown case '+id);
const work=path.resolve(workArg),repo=path.join(work,spec.checkoutName||id),out=path.join(work,'evidence'),managerHome=path.join(work,'manager');
fs.mkdirSync(out,{recursive:true});const commands=[];
const env={...process.env,CI:'1',NODE_OPTIONS:process.env.NODE_OPTIONS||'--max-old-space-size=1536',COREPACK_ENABLE_PROJECT_SPEC:'0',YARN_ENABLE_IMMUTABLE_INSTALLS:'false',npm_config_cache:path.join(work,'cache/npm'),YARN_CACHE_FOLDER:path.join(work,'cache/yarn'),BUN_INSTALL_CACHE_DIR:path.join(work,'cache/bun')};
const result={mode,id,scope:'Pinned real public checkout; native dependency validation, not a project build/test claim',repository:spec.repository,commit:spec.commit,platform:{node:process.version,os:process.platform,cpu:process.arch},status:'running',nativeChecks:0};
function save(){fs.writeFileSync(path.join(out,'commands.json'),JSON.stringify(commands,null,2)+'\n');fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');}
function run(label,argv,cwd=work,allowFailure=false,extraEnv={}){
 const start=Date.now();const x=spawnSync(argv[0],argv.slice(1),{cwd,env:{...env,...extraEnv},encoding:'utf8',maxBuffer:64*1024*1024,timeout:600000,windowsHide:true});
 fs.writeFileSync(path.join(out,label+'.stdout'),x.stdout||'');fs.writeFileSync(path.join(out,label+'.stderr'),x.stderr||'');
 const row={label,argv,cwd,exit:x.status,signal:x.signal,error:x.error?.message,seconds:(Date.now()-start)/1000};commands.push(row);save();if(!allowFailure&&(x.error||x.status!==0))throw Error(label+' failed; see evidence logs');return x;
}
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function tracked(){return run('tracked-'+commands.length,['git','ls-files','-z'],repo).stdout.split('\0').filter(Boolean);}
const sideInput=f=>f.endsWith('package.json')||/\/(?:package-lock.json|npm-shrinkwrap.json|pnpm-lock.yaml|yarn.lock|bun.lock|bun.lockb|pnpm-workspace.yaml|\.npmrc|\.yarnrc|\.yarnrc.yml|bunfig.toml)$/.test('/'+f);
function hashes(files){return Object.fromEntries(files.map(f=>[f,fs.existsSync(path.join(repo,f))?hash(path.join(repo,f)):null]));}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function snapshot(files,name){const d=path.join(out,name);for(const f of files){const src=path.join(repo,f);if(!fs.existsSync(src))continue;const dst=path.join(d,f);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}fs.writeFileSync(path.join(out,name+'-hashes.json'),JSON.stringify(hashes(files),null,2)+'\n');}
function cleanModules(files){const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name==='.git')continue;const p=path.join(dir,entry.name);if(entry.name==='node_modules'){const rel=path.relative(repo,p).split(path.sep).join('/');if(!files.some(f=>f===rel||f.startsWith(rel+'/')))fs.rmSync(p,{recursive:true,force:true});continue;}if(entry.isDirectory())walk(p);}};walk(repo);}
let bins;
function installManager(){
 const g=spec.lockgroups[0];if(!spec.lockgroups.every(x=>x.manager===g.manager&&x.version===g.version))throw Error('This portable profile needs one exact manager version per case');
 const pkg=g.manager==='yarn'&&!g.version.startsWith('1.')?'@yarnpkg/cli-dist':g.manager;
 // The bootstrap npm CLI is given explicitly on Windows, where .cmd files cannot be execFile'd.
 let bootstrap=process.env.PLATFORM_BOOTSTRAP_NPM_JS;
 if(!bootstrap){const candidates=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];bootstrap=candidates.find(p=>fs.existsSync(p));}
 if(!bootstrap)throw Error('Set PLATFORM_BOOTSTRAP_NPM_JS to the installed npm-cli.js');
 run('manager-install',[process.execPath,bootstrap,'install','--prefix',managerHome,'--no-audit','--no-fund',pkg+'@'+g.version]);
 const pkgPath=path.join(managerHome,'node_modules',...pkg.split('/')),p=JSON.parse(fs.readFileSync(path.join(pkgPath,'package.json'))),bin=typeof p.bin==='string'?p.bin:p.bin[g.manager]||p.bin.yarn;const file=path.join(pkgPath,bin);
 let cli;if(g.manager==='bun'){cli=[file];}else{cli=[process.execPath,file];}
 env.PATH=path.join(managerHome,'node_modules','.bin')+path.delimiter+env.PATH;bins=cli;
 const measured=run('manager-version',[...cli,'--version'],repo).stdout.trim();if(measured!==g.version)throw Error('Manager version '+measured+' expected '+g.version);result.manager={name:g.manager,version:measured,package:pkg};
}
function native(phase,files){const before=hashes(files);cleanModules(files);for(let i=0;i<spec.lockgroups.length;i++){
 const g=spec.lockgroups[i],cwd=path.join(repo,g.root);const frozen=g.manager==='npm'?['ci']:g.manager==='yarn'?['install',g.version.startsWith('1.')?'--frozen-lockfile':'--immutable']:['install','--frozen-lockfile'];
 const normal=g.manager==='pnpm'?['install','--no-frozen-lockfile']:['install'];
 for(const [kind,args]of[['frozen',frozen],['normal',normal]]){run(phase+'-'+i+'-'+kind,[...bins,...args],cwd);result.nativeChecks++;if(!equal(before,hashes(files)))throw Error(phase+' '+kind+' rewrote dependency inputs');save();}
 }}
function overlay(source,files){for(const f of files){const p=path.join(source,f),dst=path.join(repo,f);if(fs.existsSync(p)){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(p,dst);}else fs.rmSync(dst,{force:true});}}
try{
 if(process.version!=='v24.22.2')throw Error('Pinned Node24.22.2 required');
 run('git-init',['git','init',repo]);run('git-line-endings',['git','config','core.autocrlf','false'],repo);run('git-origin',['git','remote','add','origin',spec.repository],repo);run('git-fetch',['git','fetch','--depth','1','origin',spec.commit],repo);run('git-checkout',['git','checkout','--detach','FETCH_HEAD'],repo);
 installManager();let files=tracked().filter(sideInput);result.inputs=files;
 if(mode==='consume'){
  const data=path.join(here,'data',id),receipt=JSON.parse(fs.readFileSync(path.join(data,'receipt.json')));if(receipt.id!==id||receipt.repository!==spec.repository||receipt.commit!==spec.commit||receipt.manager.name!==result.manager.name||receipt.manager.version!==result.manager.version)throw Error('Fixture provenance mismatch');
  files=receipt.inputs;overlay(path.join(data,'baseline'),files);if(!equal(hashes(files),receipt.baselineHashes))throw Error('Baseline snapshot integrity');native('baseline',files);snapshot(files,'baseline');overlay(path.join(data,'patched'),files);if(!equal(hashes(files),receipt.patchedHashes))throw Error('Patched snapshot integrity');native('patched',files);snapshot(files,'patched');
 }else{
  if(!env.REWRITE_JAVASCRIPT_CLASSPATH||!env.REWRITE_JS_DIST)throw Error('Generation requires explicit published Java classpath and SDK dist');
  const proof=JSON.parse(fs.readFileSync(path.join(here,'runtime-provenance.json'))),expected=new Map(proof.java.artifacts.map(a=>[a.file,a.sha256])),jars=env.REWRITE_JAVASCRIPT_CLASSPATH.split(path.delimiter);if(jars.length!==expected.size||new Set(jars.map(j=>path.basename(j))).size!==expected.size)throw Error('Unexpected classpath size');for(const jar of jars)if(!fs.statSync(jar).isFile()||hash(jar)!==expected.get(path.basename(jar)))throw Error('Classpath differs from published provenance');
  const tree=crypto.createHash('sha256');const walkDist=(dir,rel='')=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const r=rel?rel+'/'+e.name:e.name;return e.isDirectory()?walkDist(path.join(dir,e.name),r):e.isFile()?[r]:[];});for(const rel of walkDist(env.REWRITE_JS_DIST).sort()){tree.update(rel);tree.update(Buffer.from([0]));tree.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(env.REWRITE_JS_DIST,...rel.split('/')))).digest());}if(tree.digest('hex')!==proof.typescript.distSha256)throw Error('SDK dist differs from published provenance');
  const sdk=JSON.parse(fs.readFileSync(path.join(path.dirname(env.REWRITE_JS_DIST),'package.json')));if(sdk.version!=='8.100.3')throw Error('Wrong SDK version');result.runtimeVersion=sdk.version;result.javaArtifactHashesVerified=jars.length;
  native('baseline',files);snapshot(files,'baseline');const before=hashes(files),input=path.join(out,'recipe-input.json');fs.writeFileSync(input,JSON.stringify(spec.recipe,null,2));
  run('recipe',[process.execPath,path.join(here,'recipe.cjs'),repo,path.join(out,'recipe'),input],here);if(!equal(before,hashes(files)))throw Error('Recipe changed checkout before patch application');const patch=path.join(out,'recipe/recipe.patch');if(!fs.statSync(patch).size)throw Error('Expected real mutation');run('patch-check',['git','apply','--check','-p0',patch],repo);run('patch-apply',['git','apply','-p0',patch],repo);const after=hashes(files);if(equal(before,after))throw Error('Patch changed no dependency inputs');snapshot(files,'patched');native('patched',files);
  run('repeat',[process.execPath,path.join(here,'recipe.cjs'),repo,path.join(out,'repeat'),input],here);if(fs.statSync(path.join(out,'repeat/recipe.patch')).size)throw Error('Recipe repeat changed files');if(!equal(after,hashes(files)))throw Error('Repeat/native input drift');result.zeroPatchRepeat=true;result.runtimeVersion='8.100.3';
 }
 result.status='passed';snapshot(files,'final');
}catch(e){result.status='failed';result.detail=e.stack||String(e);process.exitCode=1;}finally{save();console.log(JSON.stringify(result,null,2));}
