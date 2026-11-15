export const NETWORK = 'p5-ci-internal';
export const PROXY_CONTAINER = 'p5-ci-proxy';
export const PROXY_URL = 'http://proxy:3128';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function validateConfig({ owner, repo, pat, gpuMode }) {
  if (!owner || !NAME_RE.test(owner)) throw new Error('OWNER is missing or invalid');
  if (!repo || !NAME_RE.test(repo)) throw new Error('REPO is missing or invalid');
  if (!pat) throw new Error('PAT is missing');
  if (!['dri', 'nvidia'].includes(gpuMode)) throw new Error(`Unknown GPU_MODE: ${gpuMode}`);
}

// Builds the argv for `docker run`. The registration token is deliberately NOT
// part of the argv (it would show up in `ps`); it is passed via the child's
// environment instead, and `-e GITHUB_TOKEN` forwards it into the container.
export function buildRunArgs({
  owner,
  repo,
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
    '-e', `GITHUB_URL=https://github.com/${owner}/${repo}`,
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
