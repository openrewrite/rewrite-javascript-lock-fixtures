#!/usr/bin/env python3
"""Resolve the exact published runtime. Credentials stay in the runner environment."""
import json, os, pathlib, shutil, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
if not os.environ.get('CODEGENOME_USERNAME') or not os.environ.get('CODEGENOME_TOKEN'):
    raise SystemExit('Generation requires approved CODEGENOME_USERNAME/TOKEN environment credentials')
(root/'package.json').write_text(json.dumps({'private': True, 'dependencies': {'@openrewrite/rewrite': '8.100.3'}})+'\n')
node = shutil.which('node')
node_dir = pathlib.Path(node).resolve().parent
npm_cli = next((p for p in [node_dir/'node_modules/npm/bin/npm-cli.js',node_dir.parent/'lib/node_modules/npm/bin/npm-cli.js'] if p.is_file()),None)
if not npm_cli: raise SystemExit('Cannot locate npm-cli.js for this Node distribution')
subprocess.run([node,str(npm_cli),'install','--ignore-scripts','--no-audit','--no-fund'],cwd=root,check=True)
(root/'pom.xml').write_text('''<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>validation</groupId><artifactId>platform-locks</artifactId><version>1</version><repositories><repository><id>codegenome</id><url>https://artifacts.codegenomeproject.org/maven</url></repository></repositories><dependencies><dependency><groupId>org.openrewrite</groupId><artifactId>rewrite-javascript</artifactId><version>8.100.3</version></dependency><dependency><groupId>org.openrewrite</groupId><artifactId>rewrite-maven</artifactId><version>8.100.3</version></dependency></dependencies></project>''')
settings=root/'private-settings.xml'
settings.write_text('''<settings><servers><server><id>codegenome</id><username>${env.CODEGENOME_USERNAME}</username><password>${env.CODEGENOME_TOKEN}</password></server></servers></settings>''')
settings.chmod(0o600)
try:
    maven=shutil.which('mvn')
    if not maven: raise SystemExit('Maven is required')
    args=[maven,'-B','-q','-s',str(settings),'-Dmaven.repo.local='+str(root/'m2'),'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath','-Dmdep.outputFile='+str(root/'classpath.txt')]
    subprocess.run(args,cwd=root,check=True,shell=os.name=='nt')
finally:
    settings.unlink(missing_ok=True)
with open(os.environ['GITHUB_ENV'],'a',encoding='utf8') as out:
    out.write('REWRITE_JAVASCRIPT_CLASSPATH='+(root/'classpath.txt').read_text().strip()+'\n')
    out.write('REWRITE_JS_DIST='+str(root/'node_modules/@openrewrite/rewrite/dist')+'\n')
