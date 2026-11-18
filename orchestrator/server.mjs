import { spawn, execFile } from 'child_process';
import { readFileSync, statSync } from 'fs';
import util from 'util';
import { buildRunArgs, createAppJwt, validateConfig, NETWORK, PROXY_CONTAINER } from './lib.mjs';

const execFileAsync = util.promisify(execFile);

// === CONFIG ===
const OWNER = process.env.OWNER; // the GitHub organization
const RUNNER_GROUP = process.env.RUNNER_GROUP; // optional, defaults to the "Default" group
// GitHub App owned by and installed on the org, with Organization permission
// "Self-hosted runners: read and write"
const APP_CLIENT_ID = process.env.APP_CLIENT_ID;
const APP_PRIVATE_KEY_PATH = process.env.APP_PRIVATE_KEY_PATH;
const GPU_MODE = process.env.GPU_MODE || 'dri'; // 'dri' or 'nvidia'
const POLL_INTERVAL = 15_000; // 15s
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 3 * 60 * 60 * 1000;

validateConfig({
  owner: OWNER,
  runnerGroup: RUNNER_GROUP,
  clientId: APP_CLIENT_ID,
  appPrivateKeyPath: APP_PRIVATE_KEY_PATH,
  gpuMode: GPU_MODE,
});
const APP_PRIVATE_KEY = readFileSync(APP_PRIVATE_KEY_PATH, 'utf8');
console.log(`Registering runners for ${OWNER} (runner group: ${RUNNER_GROUP || 'Default'}) as GitHub App ${APP_CLIENT_ID}`);

// The container's render group GID has to match the host's, or the GPU isn't accessible
const DRI_DEVICE = process.env.DRI_DEVICE || '/dev/dri/renderD128';
const RENDER_GID = GPU_MODE === 'dri' ? statSync(DRI_DEVICE).gid : undefined;

let currentContainer = null;

async function githubRequest(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      ...(body && { 'Content-Type': 'application/json' })
    },
    body: body && JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

let installationId = null;
let installationToken = null; // { token, expiresAt }

// Installation tokens last an hour and act as the app, so they are limited to what the
// installation was granted, not to the permissions of whoever created the app.
async function getInstallationToken() {
  if (installationToken && installationToken.expiresAt - Date.now() > 5 * 60_000) {
    return installationToken.token;
  }
  const jwt = createAppJwt({ clientId: APP_CLIENT_ID, privateKey: APP_PRIVATE_KEY });
  if (!installationId) {
    try {
      installationId = (await githubRequest(`/orgs/${OWNER}/installation`, jwt)).id;
    } catch (err) {
      throw new Error(`Is the app installed on ${OWNER}? ${err.message}`);
    }
    console.log(`Using GitHub App installation ${installationId}`);
  }
  const data = await githubRequest(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: 'POST'
  });
  installationToken = { token: data.token, expiresAt: Date.parse(data.expires_at) };
  return data.token;
}

// Fetch ephemeral runner registration token from GitHub
async function getEphemeralToken() {
  try {
    const data = await githubRequest(
      `/orgs/${OWNER}/actions/runners/registration-token`,
      await getInstallationToken(),
      { method: 'POST' }
    );
    return data.token;
  } catch (err) {
    throw new Error(`Failed to get ephemeral token: ${err.message}`);
  }
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
  const args = buildRunArgs({
    owner: OWNER,
    runnerGroup: RUNNER_GROUP,
    gpuMode: GPU_MODE,
    containerName,
    driDevice: DRI_DEVICE,
    renderGid: RENDER_GID,
  });

  console.log(`Starting ${containerName} with GPU_MODE=${GPU_MODE}...`);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, GITHUB_TOKEN: token },
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
