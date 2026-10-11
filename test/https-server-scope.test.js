/**
 * start_https.sh serves the app on 0.0.0.0: runs its embedded server (minus
 * TLS, on an ephemeral port) and checks key.pem, .git and gmp-core/data are not
 * served.
 *
 * Run with: node test/https-server-scope.test.js   (skips without python3)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
if (spawnSync('python3', ['--version']).status !== 0) {
  console.log('  skip  python3 not available');
  process.exit(0);
}

const script = fs.readFileSync(path.join(root, 'start_https.sh'), 'utf8');
const m = /python3 -c "\n([\s\S]*?)\n"/.exec(script);
assert.ok(m, 'could not find the embedded server in start_https.sh');
const server = m[1]
  .replace('$HTTPS_PORT', '0')
  .replace(/^ctx.*$\n?/gm, '')
  .replace(/^httpd\.socket = .*$\n?/gm, '')
  .replace(/^print\(.*$\n?/gm, '')
  .replace(/^httpd\.serve_forever\(\)$/m, '');

const probe = `
import threading, urllib.request, json
${server}
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_address[1]
out = {}
for p in ${JSON.stringify(['/', '/index.html', '/app.bundle.js', '/src/utils/bip39.js', '/shared/wordlist.js',
                            '/key.pem', '/cert.pem', '/.git/HEAD', '/src/../key.pem', '/%2e%2e/key.pem',
                            '/gmp-core/data/peer-cache.json', '/package.json'])}:
    try:
        out[p] = urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, p)).status
    except Exception as e:
        out[p] = getattr(e, 'code', 0)
httpd.shutdown()
print(json.dumps(out))
`;
const r = spawnSync('python3', ['-c', probe], { cwd: root, encoding: 'utf8' });
assert.strictEqual(r.status, 0, r.stderr);
const got = JSON.parse(r.stdout.trim().split('\n').pop());

let failures = 0;
for (const p of ['/', '/index.html', '/app.bundle.js', '/src/utils/bip39.js', '/shared/wordlist.js']) {
  if (got[p] === 200) console.log(`  ok  serves ${p}`);
  else { failures++; console.log(`  FAIL ${p} should be served, got ${got[p]}`); }
}
for (const p of ['/key.pem', '/cert.pem', '/.git/HEAD', '/src/../key.pem', '/%2e%2e/key.pem', '/gmp-core/data/peer-cache.json', '/package.json']) {
  if (got[p] === 404) console.log(`  ok  refuses ${p}`);
  else { failures++; console.log(`  FAIL ${p} must not be served, got ${got[p]}`); }
}
process.exit(failures ? 1 : 0);
