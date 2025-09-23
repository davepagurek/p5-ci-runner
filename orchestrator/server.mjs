import fetch from 'node-fetch';
import { exec, execSync } from 'child_process';
import util from 'util';
import http from 'http';
import httpProxy from 'http-proxy';
import net from 'net';
const { createProxyServer } = httpProxy;

const allowedHosts = [/(.*\.)?github.com$/, /(.*\.)?githubusercontent.com$/, /^fonts.googleapis.com$/, /^fonts.gstatic.com$/, /^codeload.github.com$/, /(.*\.)?windows.net$/, /(.*\.)?npmjs.org$/, /(.*\.)?googleapis.com$/, /(.*\.)?github.io$/];

const proxy = createProxyServer({});

const execAsync = util.promisify(exec);

// === CONFIG ===
const OWNER = process.env.OWNER;
const REPO = process.env.REPO;
const BASE_IMAGE = 'p5-ci-runner:latest';
const PAT = process.env.PAT; // GitHub personal access token
const POLL_INTERVAL = 15_000; // 15s
const GPU_MODE = process.env.GPU_MODE || 'dri'; // 'dri' or 'nvidia'

function getDockerHostIP() {
  try {
    // Runs: ip -4 addr show docker0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'
    const output = execSync(
      "ip -4 addr show docker0 | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}'"
    ).toString().trim();

    if (!output) {
      throw new Error('docker0 interface not found or no IP assigned');
    }

    return output;
  } catch (err) {
    console.error('Error getting Docker host IP:', err.message);
    return null;
  }
}
const ip = getDockerHostIP();

// Fetch ephemeral token from GitHub
async function getEphemeralToken() {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/runners/registration-token`,
    {
      method: 'POST',
      headers: {
        'Authorization': `token ${PAT}`,
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

// Run container with the appropriate GPU flags
async function runJobContainer(token) {
  let gpuFlags = '';
  if (GPU_MODE === 'dri') {
    gpuFlags = '--device /dev/dri:/dev/dri';
  } else if (GPU_MODE === 'nvidia') {
    gpuFlags = '--gpus all';
  } else {
    throw new Error(`Unknown GPU_MODE: ${GPU_MODE}`);
  }

  const cmd = `
    docker run --rm -e GITHUB_URL=https://github.com/${OWNER}/${REPO} \
               -e HTTP_PROXY=http://${ip}:3128 \
               -e HTTPS_PROXY=http://${ip}:3128 \
               -e GITHUB_TOKEN=${token} \
               ${gpuFlags} \
               ${BASE_IMAGE}
  `;
               // --network host \
  console.log(`Starting container with GPU_MODE=${GPU_MODE}...`);
  const { stdout, stderr } = await execAsync(cmd);
  console.log(stdout);
  if (stderr) console.error(stderr);
}

// Orchestrator loop
async function orchestratorLoop() {
  while (true) {
    try {
      const token = await getEphemeralToken();
      await runJobContainer(token);
    } catch (err) {
      console.error('Error in orchestrator:', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// Proxy server
const server = http.createServer((req, res) => {
  const host = req.headers.host;
  if (!allowedHosts.some(r => r.exec(host))) {
    console.log(`Blocking connection to ${host}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  proxy.web(req, res, { target: `https://${host}`, changeOrigin: true });
});
// Handle HTTPS CONNECT requests
server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  if (!allowedHosts.some(r => r.exec(host))) {
    console.log(`Blocking connection to ${host}`);
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  // Connect to the target
  const serverSocket = net.connect(port || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => serverSocket.destroy());
});

orchestratorLoop(); // Start orchestrator running
server.listen(3128, () => console.log('Proxy listening on port 3128'));

