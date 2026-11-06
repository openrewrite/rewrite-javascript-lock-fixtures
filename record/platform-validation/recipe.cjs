// Fresh parsing deliberately replaces unavailable consumer LSTs. Never edits the checkout.
const fs=require('node:fs'), path=require('node:path'),{execFileSync}=require('node:child_process');
const base=path.resolve(process.env.REWRITE_JS_DIST||'runtime/node_modules/@openrewrite/rewrite/dist');
const {PackageJsonParser,findNodeRuntime,findNodeResolutionResult}=require(base+'/javascript');
const {JsonParser}=require(base+'/json'),{PlainTextParser}=require(base+'/text');
const {YamlParser}=require(base+'/yaml');
const {JavaRpcTestServer}=require(base+'/rpc/java-rpc-client');
const semver=require(require.resolve('semver',{paths:[base]}));
const {createTwoFilesPatch}=require(require.resolve('diff',{paths:[base]}));
const {prepareJavaRecipe}=require(base+'/rpc/java-recipe');
const {scheduleRun}=require(base+'/run'),{ExecutionContext}=require(base+'/execution');
const {TreePrinters,PrintOutputCapture,MarkerPrinter}=require(base+'/print');
(async()=>{
 const [root,output,input]=process.argv.slice(2), spec=JSON.parse(fs.readFileSync(input));
 fs.mkdirSync(output,{recursive:true});
 const server=await JavaRpcTestServer.start();
 try {
  await server.rpc.connection.sendRequest('SetDataTableStore',{kind:'CSV',outputDir:path.join(output,'tables')});
  const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
  const sources=[],runtimes=[];
  const pkgParser=new PackageJsonParser({relativeTo:root});
  for(const file of files){
   // Include textual side inputs such as native patch files, local/file packages and manager plugins.
   // Dependency recipes need metadata trees, not compiler attribution for application sources.
   const abs=path.join(root,file);if(!fs.statSync(abs).isFile())continue;
   if(fs.readFileSync(abs).includes(0)){if(/(^|\/)bun\.lockb$/.test(file))throw Error('Unsupported binary lock input: '+file);continue;}
   const parser=file.endsWith('package.json')?pkgParser:/(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(file)?new JsonParser({relativeTo:root}):/\.ya?ml$/.test(file)?new YamlParser({relativeTo:root}):new PlainTextParser({relativeTo:root});
   for await(const source of parser.parse(abs)){
    sources.push(source);
    if(file.endsWith('package.json'))runtimes.push({file,runtime:findNodeRuntime(source),hasResolution:!!findNodeResolutionResult(source)});
   }
  }
  const errors=sources.filter(s=>s.kind.includes('ParseError')).map(s=>s.sourcePath);
  fs.writeFileSync(path.join(output,'parse-summary.json'),JSON.stringify({mode:'fresh-pinned-files-no-consumer-LST',files:sources.length,runtimes,errors},null,2));
  if(errors.length)throw Error('Parse errors: '+errors.join(','));
  // State tests include deliberate no-op reruns, adds, removals and renames.
  // Expected changes/no-ops are asserted by the external state driver.
  const {Recipe}=require(base+'/recipe');
  const specs=spec.recipeList||[spec];
  const prepared=[];
  for(const r of specs)prepared.push(await prepareJavaRecipe(r.id,r.options||{}));
  class Composite extends Recipe {
    name='validation.NativeLockStateSequence';
    displayName='Validate composed dependency recipes';
    description='Execute real prepared Java recipes through the standard scheduler.';
    async recipeList(){return prepared;}
  }
  const recipe=spec.recipeList?new Composite():prepared[0];
  const result=await scheduleRun(recipe,sources,new ExecutionContext());let patch='',displayPatch='';const changes=[];
  for(const r of result.changeset){
   const before=r.before?await TreePrinters.print(r.before,new PrintOutputCapture(MarkerPrinter.SANITIZED)):undefined;
   const after=r.after?await TreePrinters.print(r.after,new PrintOutputCapture(MarkerPrinter.SANITIZED)):undefined;
   if(before===after)continue;
   changes.push({before:r.before?.sourcePath,after:r.after?.sourcePath});displayPatch+=await r.diff();patch+=createTwoFilesPatch(r.before?.sourcePath||'',r.after?.sourcePath||'',before||'',after||'','','',{context:3});
  }
  fs.writeFileSync(path.join(output,'recipe.patch'),patch);
  fs.writeFileSync(path.join(output,'display.patch'),displayPatch);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({recipe:spec,changes},null,2));
 }finally{await server.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});
