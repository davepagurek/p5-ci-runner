import { constants, createPrivateKey, sign } from 'crypto';

export const NETWORK = 'p5-ci-internal';
export const PROXY_CONTAINER = 'p5-ci-proxy';
export const PROXY_URL = 'http://proxy:3128';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const GROUP_RE = /^[A-Za-z0-9 _.-]+$/;

export function validateConfig({ owner, runnerGroup, clientId, appPrivateKeyPath, gpuMode }) {
  if (!owner || !NAME_RE.test(owner)) throw new Error('OWNER is missing or invalid');
  if (runnerGroup && !GROUP_RE.test(runnerGroup)) throw new Error('RUNNER_GROUP is invalid');
  if (!clientId || !/^[A-Za-z0-9._-]+$/.test(clientId)) throw new Error('APP_CLIENT_ID is missing or invalid');
  if (!appPrivateKeyPath) throw new Error('APP_PRIVATE_KEY_PATH is missing');
  if (!['dri', 'nvidia'].includes(gpuMode)) throw new Error(`Unknown GPU_MODE: ${gpuMode}`);
}

// JS transliteration of the PowerShell example in GitHub's docs, kept as close to it as possible:
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
const toBase64Url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function createAppJwt({ clientId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = toBase64Url(Buffer.from(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT'
  }), 'utf8'));

  const payload = toBase64Url(Buffer.from(JSON.stringify({
    iat: now - 10,
    exp: now + 10 * 60,
    iss: clientId
  }), 'utf8'));

  const rsa = createPrivateKey(privateKey);

  const signature = toBase64Url(sign(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    { key: rsa, padding: constants.RSA_PKCS1_PADDING }
  ));
  return `${header}.${payload}.${signature}`;
}

// Builds the argv for `docker run`. The registration token is deliberately NOT
// part of the argv (it would show up in `ps`); it is passed via the child's
// environment instead, and `-e GITHUB_TOKEN` forwards it into the container.
export function buildRunArgs({
  owner,
  runnerGroup, // optional; defaults to the org's "Default" runner group
  gpuMode,
  containerName,
  image = 'p5-ci-runner:latest',
  driDevice = '/dev/dri/renderD128',
  // Group that owns driDevice on the host. The image's own render group GID is a guess,
  // so without this the runner user can't open the GPU and Vulkan falls back to llvmpipe (CPU).
  renderGid,
  memory = '8g',
  cpus = '4',
  pidsLimit = '4096',
}) {
  if (gpuMode !== 'nvidia' && gpuMode !== 'dri') {
    throw new Error(`Unknown GPU_MODE: ${gpuMode}`);
  }
  if (gpuMode === 'dri' && renderGid === undefined) {
    throw new Error('renderGid is required for GPU_MODE=dri');
  }
  const gpuArgs =
    gpuMode === 'nvidia'
      ? ['--gpus', 'all']
      : ['--device', driDevice, '--group-add', String(renderGid)];

  return [
    'run', '--rm',
    '--name', containerName,
    '--network', NETWORK,
    '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', pidsLimit,
    '--memory', memory,
    '--cpus', cpus,
    '-e', `GITHUB_URL=https://github.com/${owner}`,
    ...(runnerGroup ? ['-e', `RUNNER_GROUP=${runnerGroup}`] : []),
    '-e', 'GITHUB_TOKEN',
    // Both cases: curl/git only read lowercase http_proxy, others only uppercase.
    '-e', `HTTP_PROXY=${PROXY_URL}`,
    '-e', `HTTPS_PROXY=${PROXY_URL}`,
    '-e', `http_proxy=${PROXY_URL}`,
    '-e', `https_proxy=${PROXY_URL}`,
    '-e', 'NO_PROXY=localhost,127.0.0.1',
    '-e', 'no_proxy=localhost,127.0.0.1',
    ...gpuArgs,
    image,
  ];
}
