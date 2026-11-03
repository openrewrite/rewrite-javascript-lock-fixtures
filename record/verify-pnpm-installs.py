#!/usr/bin/env python3
"""Verify a recorded PNPM scenario with full frozen and ordinary installs before and after its edit.
Usage: python3 record/verify-pnpm-installs.py SCENARIO /absolute/path/to/pnpm
Writes native-{before,after}-{frozen,normal}.log and native-installs.json; installed trees are removed.
"""
import pathlib,tempfile,subprocess,os,shutil,json,hashlib,datetime,sys
executable = str(pathlib.Path(sys.argv[2]).resolve())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def case(d):
 version=(d/'recorded-with').read_text().split(',')[0].split()[1]; exe=executable; rows=[]
 for phase,pkg,lock in [('before','pkg-before','before'),('after','pkg','after')]:
  with tempfile.TemporaryDirectory(prefix='pnpm10-native-') as temp:
   work=pathlib.Path(temp);p=work/'project';p.mkdir();home=work/'home';home.mkdir()
   for tree in ['tree-before']+(['tree'] if phase=='after' else []):
    if (d/tree).exists():shutil.copytree(d/tree,p,dirs_exist_ok=True)
   w=d/('workspace-before' if phase=='before' and (d/'workspace-before').exists() else 'workspace')
   if w.exists():shutil.copyfile(w,p/'pnpm-workspace.yaml')
   if (d/'npmrc').exists():shutil.copyfile(d/'npmrc',p/'.npmrc')
   shutil.copyfile(d/pkg,p/'package.json');shutil.copyfile(d/lock,p/'pnpm-lock.yaml')
   env=dict(os.environ,HOME=str(home),CI='true',XDG_CONFIG_HOME=str(home/'.config'),XDG_CACHE_HOME=str(home/'.cache'),XDG_DATA_HOME=str(home/'.local/share'),XDG_STATE_HOME=str(home/'.local/state'),npm_config_userconfig='/dev/null',pnpm_config_userconfig='/dev/null',pnpm_config_npmrc_auth_file='/dev/null',pnpm_config_update_notifier='false')
   for secret in ['CODEGENOME_USERNAME','CODEGENOME_TOKEN']:env.pop(secret,None)
   actual=subprocess.check_output([exe,'--version'],cwd=p,env=env,text=True).strip()
   if actual!=version:raise RuntimeError(f'Expected pnpm {version}, executable ran {actual}')
   original={str(f.relative_to(p)):sha(f) for f in p.rglob('*') if f.is_file()}
   for mode,flag in [('frozen','--frozen-lockfile'),('normal','--no-frozen-lockfile')]:
    argv=[exe,'install',flag,'--no-color','--store-dir='+str(work/'store')];r=subprocess.run(argv,cwd=p,env=env,capture_output=True,text=True,timeout=180)
    log=(r.stdout+r.stderr).replace(temp,'<scratch>');(d/f'native-{phase}-{mode}.log').write_text(log)
    unchanged=all((p/f).exists() and sha(p/f)==h for f,h in original.items())
    rows.append({'phase':phase,'mode':mode,'command':['pnpm@'+version]+argv[1:-1], 'exit':r.returncode,'inputsUnchanged':unchanged,'lockSha256':sha(p/'pnpm-lock.yaml')})
    if r.returncode or not unchanged:raise RuntimeError(str((d.name,rows[-1],log[-500:])))
 (d/'native-installs.json').write_text(json.dumps({'pnpm':version,'node':subprocess.check_output(['node','--version'],text=True).strip(),'executableSha256':sha(pathlib.Path(exe)),'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commands':rows},indent=2)+'\n')
 return d.name,len(rows)
print(*case(pathlib.Path(sys.argv[1]).resolve()))
