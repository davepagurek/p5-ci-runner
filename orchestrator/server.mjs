import { spawn, execFile } from 'child_process';
import util from 'util';
import { buildRunArgs, validateConfig, NETWORK, PROXY_CONTAINER } from './lib.mjs';

const execFileAsync = util.promisify(execFile);

// === CONFIG ===
const OWNER = process.env.OWNER;
const REPO = process.env.REPO;
const PAT = process.env.PAT; // GitHub fine-grained token (Administration: read/write on this repo)
const GPU_MODE = process.env.GPU_MODE || 'dri'; // 'dri' or 'nvidia'
const POLL_INTERVAL = 15_000; // 15s
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 3 * 60 * 60 * 1000;

validateConfig({ owner: OWNER, repo: REPO, pat: PAT, gpuMode: GPU_MODE });

let currentContainer = null;

// Fetch ephemeral token from GitHub
async function getEphemeralToken() {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/runners/registration-token`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Accept': 'application/vnd.github+json'
      }
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get ephemeral token: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.token;
}

// Refuse to start a runner unless the isolated network and proxy are in place,
// so a broken setup means "no jobs" rather than a runner with open network access.
async function checkSandbox() {
  try {
    await execFileAsync('docker', ['network', 'inspect', NETWORK]);
    const { stdout } = await execFileAsync('docker', [
      'inspect', '-f', '{{.State.Running}}', PROXY_CONTAINER,
    ]);
    if (stdout.trim() !== 'true') throw new Error('proxy not running');
  } catch (err) {
    throw new Error(`Sandbox not ready (run setup.sh): ${err.message}`);
  }
}

function killContainer(name) {
  execFile('docker', ['kill', name], () => {});
}

// Run container with the appropriate GPU flags
function runJobContainer(token) {
  const containerName = `p5-ci-job-${Date.now()}`;
  const args = buildRunArgs({ owner: OWNER, repo: REPO, gpuMode: GPU_MODE, containerName });

  console.log(`Starting ${containerName} with GPU_MODE=${GPU_MODE}...`);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, PAT: undefined, GITHUB_TOKEN: token },
      stdio: 'inherit',
    });
    currentContainer = containerName;

    const timer = setTimeout(() => {
      console.error(`${containerName} exceeded ${JOB_TIMEOUT_MS}ms, killing`);
      killContainer(containerName);
    }, JOB_TIMEOUT_MS);

    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      currentContainer = null;
      if (code === 0) resolve();
      else reject(new Error(`${containerName} exited with code ${code}`));
    });
  });
}

// Orchestrator loop
async function orchestratorLoop() {
  while (true) {
    try {
      await checkSandbox();
      const token = await getEphemeralToken();
      await runJobContainer(token);
    } catch (err) {
      console.error('Error in orchestrator:', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (currentContainer) killContainer(currentContainer);
    process.exit(0);
  });
}

orchestratorLoop(); // Start orchestrator running
