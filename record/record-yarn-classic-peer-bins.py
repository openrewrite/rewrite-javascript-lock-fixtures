#!/usr/bin/env python3
"""Record Yarn's dependency/peer bin collision and its --no-bin-links control.

Usage: python3 record/record-yarn-classic-peer-bins.py [port]
Requires yarn 1.22.22 on PATH. Records through record-yarn-classic-open.sh;
no lock is constructed or edited by this script.
"""
import base64
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading

REPO = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18746
UNION = '^6.0.0 || ^7.0.0 || ^8.0.0'
PACKAGES = {
    'a': {'7.0.0': {'bin': {'a': 'cli.js'}}, '8.0.0': {'bin': {'a': 'cli.js'}}},
    'b': {'1.0.0': {'dependencies': {'a': UNION, '@probe/mocker': '1.0.0'},
                    'peerDependencies': {'a': UNION}}},
    '@probe/mocker': {'1.0.0': {'peerDependencies': {'a': UNION}}},
}

with tempfile.TemporaryDirectory() as scratch:
    documents = Path(scratch)
    for name, versions in PACKAGES.items():
        manifests = {}
        for version, fields in versions.items():
            pkg = {'name': name, 'version': version, 'license': 'MIT', **fields}
            out = io.BytesIO()
            with tarfile.open(fileobj=out, mode='w:gz') as archive:
                for file, data in {'package.json': json.dumps(pkg).encode(),
                                   'cli.js': b'#!/usr/bin/env node\n'}.items():
                    info = tarfile.TarInfo('package/' + file)
                    info.size = len(data)
                    info.mode = 0o755
                    archive.addfile(info, io.BytesIO(data))
            data = out.getvalue()
            target = documents / (name + '-' + version + '.tgz')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            pkg['dist'] = {
                'tarball': f'http://127.0.0.1:{PORT}/{name}/-/{name}-{version}.tgz',
                'shasum': hashlib.sha1(data).hexdigest(),
                'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode(),
            }
            manifests[version] = pkg
        (documents / name).write_text(json.dumps({'name': name,
            'dist-tags': {'latest': list(versions)[-1]}, 'versions': manifests}))

    class Registry(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            file = documents / self.path.lstrip('/').replace('%2f', '/').split('/-/')[-1]
            if not file.is_file():
                self.send_error(404)
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(file.read_bytes())

        def log_message(self, *_args):
            pass

    server = http.server.HTTPServer(('127.0.0.1', PORT), Registry)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        for suffix in ['', '-no-bin-links']:
            scenario = REPO / 'lock/yarn-classic' / ('peer-bin-version-collision' + suffix)
            scenario.mkdir(parents=True, exist_ok=True)
            before = {'name': 'bin-probe', 'version': '1.0.0', 'license': 'MIT'}
            (scenario / 'pkg-before').write_text(json.dumps(before) + '\n')
            (scenario / 'pkg').write_text(json.dumps({**before,
                'dependencies': {'a': '^7.0.0', 'b': '1.0.0'}}) + '\n')
            (scenario / 'yarnrc').write_text(f'registry "http://127.0.0.1:{PORT}"\n' +
                ('--install.no-bin-links true\n' if suffix else ''))
            shutil.copytree(documents, scenario / 'http', dirs_exist_ok=True)
            subprocess.run(['bash', str(REPO / 'record/record-yarn-classic-open.sh'), str(scenario)],
                env={**os.environ, 'NO_HTTP': '1'}, check=True)
            (scenario / 'expect').write_text('exact\n' if suffix else
                'pm-fails Invariant Violation: could not find a copy of a to link in\n')
    finally:
        server.shutdown()
        server.server_close()
