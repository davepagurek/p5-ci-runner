import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildRunArgs, createAppJwt, validateConfig, NETWORK } from '../lib.mjs';

const base = { owner: 'processing', gpuMode: 'dri', containerName: 'job-1', renderGid: 992 };
const pair = (args, flag, value) =>
  args.some((a, i) => a === flag && args[i + 1] === value);

test('runs on the internal network with the proxy configured', () => {
  const args = buildRunArgs(base);
  assert.ok(pair(args, '--network', NETWORK));
  for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.ok(pair(args, '-e', `${v}=http://proxy:3128`), v);
  }
});

test('registers against the org, optionally into a runner group', () => {
  const args = buildRunArgs(base);
  assert.ok(pair(args, '-e', 'GITHUB_URL=https://github.com/processing'));
  assert.ok(!args.some((a) => a.startsWith('RUNNER_GROUP=')));
  assert.ok(pair(buildRunArgs({ ...base, runnerGroup: 'p5 gpu' }), '-e', 'RUNNER_GROUP=p5 gpu'));
});

test('applies hardening and resource limits', () => {
  const args = buildRunArgs(base);
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(pair(args, '--security-opt', 'no-new-privileges'));
  for (const f of ['--pids-limit', '--memory', '--cpus']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.some((a) => a.startsWith('--network=host') || a === 'host'));
});

test('registration token is forwarded by name only, never by value', () => {
  const args = buildRunArgs(base);
  assert.ok(pair(args, '-e', 'GITHUB_TOKEN'));
  assert.ok(!args.some((a) => /^GITHUB_TOKEN=/.test(a)));
});

test('dri mode passes only the render node, not all of /dev/dri', () => {
  const args = buildRunArgs(base);
  assert.ok(pair(args, '--device', '/dev/dri/renderD128'));
  assert.ok(!args.includes('/dev/dri'));
  assert.ok(!args.includes('--gpus'));
});

test('dri mode adds the host render group so the GPU is accessible', () => {
  assert.ok(pair(buildRunArgs(base), '--group-add', '992'));
  assert.throws(() => buildRunArgs({ ...base, renderGid: undefined }), /renderGid/);
});

test('nvidia mode uses --gpus all', () => {
  const args = buildRunArgs({ ...base, gpuMode: 'nvidia' });
  assert.ok(pair(args, '--gpus', 'all'));
  assert.ok(!args.includes('--device'));
});

test('unknown GPU mode is rejected', () => {
  assert.throws(() => buildRunArgs({ ...base, gpuMode: 'amd' }), /GPU_MODE/);
});

test('image is the last argument', () => {
  assert.equal(buildRunArgs(base).at(-1), 'p5-ci-runner:latest');
});

test('validateConfig rejects missing or shell-ish values', () => {
  const ok = { owner: 'processing', gpuMode: 'dri', clientId: 'Iv23liAbCdEf1234', appPrivateKeyPath: '/etc/key.pem' };
  validateConfig(ok);
  validateConfig({ ...ok, runnerGroup: 'p5 gpu' });
  assert.throws(() => validateConfig({ ...ok, owner: '' }), /OWNER/);
  assert.throws(() => validateConfig({ ...ok, owner: 'a/b' }), /OWNER/);
  assert.throws(() => validateConfig({ ...ok, runnerGroup: 'a; rm -rf /' }), /RUNNER_GROUP/);
  assert.throws(() => validateConfig({ ...ok, clientId: '' }), /APP_CLIENT_ID/);
  assert.throws(() => validateConfig({ ...ok, clientId: 'a b;c' }), /APP_CLIENT_ID/);
  assert.throws(() => validateConfig({ ...ok, appPrivateKeyPath: '' }), /APP_PRIVATE_KEY_PATH/);
  assert.throws(() => validateConfig({ ...ok, gpuMode: 'x' }), /GPU_MODE/);
});

// Same format as the .pem file GitHub gives you when generating an app's private key
const generateRsaKeyPair = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});

test('createAppJwt produces a valid RS256 token GitHub would accept', () => {
  const { publicKey, privateKey } = generateRsaKeyPair();
  const now = 1_800_000_000;
  const [h, p, s] = createAppJwt({ clientId: 'Iv23liAbCdEf1234', privateKey, now }).split('.');

  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'Iv23liAbCdEf1234');
  assert.ok(claims.iat < now, 'iat is backdated for clock drift');
  assert.ok(claims.exp - now <= 10 * 60, 'GitHub rejects tokens valid for more than 10 minutes');
  assert.ok(claims.exp > now);

  const verifier = createVerify('RSA-SHA256').update(`${h}.${p}`);
  assert.ok(verifier.verify(publicKey, s, 'base64url'));
  // Tampering with the claims must invalidate the signature
  const forged = createVerify('RSA-SHA256').update(`${h}.${Buffer.from('{"iss":"1"}').toString('base64url')}`);
  assert.ok(!forged.verify(publicKey, s, 'base64url'));
});

test('createAppJwt output is unpadded base64url', () => {
  const { privateKey } = generateRsaKeyPair();
  // 256-byte RSA signatures always need '=' padding in plain base64, so this exercises the trimming
  for (let i = 0; i < 20; i++) {
    const jwt = createAppJwt({ clientId: `Iv23li${i}`, privateKey });
    assert.match(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  }
});

test('entrypoint drops the registration token before starting the runner', () => {
  const s = readFileSync(new URL('../../runner/entrypoint.sh', import.meta.url), 'utf8');
  const unset = s.indexOf('unset GITHUB_TOKEN');
  assert.ok(unset > s.indexOf('./config.sh'));
  assert.ok(unset < s.indexOf('exec ./run.sh'));
});

test('entrypoint passes the runner group to config.sh only when set', () => {
  const s = readFileSync(new URL('../../runner/entrypoint.sh', import.meta.url), 'utf8');
  assert.ok(s.includes('--runnergroup "$RUNNER_GROUP"'));
  assert.ok(s.includes('[ -n "${RUNNER_GROUP:-}" ]'));
});
