import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRunArgs, validateConfig, NETWORK } from '../lib.mjs';

const base = { owner: 'processing', repo: 'p5.js', gpuMode: 'dri', containerName: 'job-1' };
const pair = (args, flag, value) =>
  args.some((a, i) => a === flag && args[i + 1] === value);

test('runs on the internal network with the proxy configured', () => {
  const args = buildRunArgs(base);
  assert.ok(pair(args, '--network', NETWORK));
  for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.ok(pair(args, '-e', `${v}=http://proxy:3128`), v);
  }
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
  const ok = { owner: 'processing', repo: 'p5.js', pat: 'x', gpuMode: 'dri' };
  validateConfig(ok);
  assert.throws(() => validateConfig({ ...ok, owner: '' }));
  assert.throws(() => validateConfig({ ...ok, repo: 'a; rm -rf /' }));
  assert.throws(() => validateConfig({ ...ok, pat: '' }));
  assert.throws(() => validateConfig({ ...ok, gpuMode: 'x' }));
});

test('entrypoint drops the registration token before starting the runner', () => {
  const s = readFileSync(new URL('../../runner/entrypoint.sh', import.meta.url), 'utf8');
  const unset = s.indexOf('unset GITHUB_TOKEN');
  assert.ok(unset > s.indexOf('./config.sh'));
  assert.ok(unset < s.indexOf('exec ./run.sh'));
});
