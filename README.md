## Setup

On the server (Debian/Ubuntu), from the root of this repo:

```sh
sudo ./setup.sh
```

...or with an NVIDIA GPU:
```sh
sudo ./setup.sh --nvidia
```

Re-run it after changing anything in `proxy/` or `runner/` (e.g. `proxy/allowed_domains.txt`). Use `--recreate-network` if you change network settings.

## Orchestrator

Create a fine-grained token at https://github.com/settings/personal-access-tokens, limited to the one repo, with only the "Administration: read and write" permission.

```sh
cd orchestrator
GPU_MODE=dri OWNER=processing REPO=p5.js PAT=your_token_here node server.mjs
```

Use `GPU_MODE=nvidia` if using an nvidia GPU.

## Running automatically at startup

Put the settings in an env file only root can read, so the token isn't on the command line:

```sh
sudo tee /etc/p5-ci-orchestrator.env >/dev/null <<'EOF'
GPU_MODE=dri
OWNER=processing
REPO=p5.js
PAT=your_token_here
EOF
sudo chmod 600 /etc/p5-ci-orchestrator.env
```

Create the service, replacing `youruser` with the user that's in the `docker` group and adjusting the paths to where you cloned this repo and where `which node` points:

```sh
sudo tee /etc/systemd/system/p5-ci-orchestrator.service >/dev/null <<'EOF'
[Unit]
Description=p5 CI runner orchestrator
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
User=youruser
WorkingDirectory=/home/youruser/p5-ci-runner/orchestrator
EnvironmentFile=/etc/p5-ci-orchestrator.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now p5-ci-orchestrator
```

Check on it with:
```sh
systemctl status p5-ci-orchestrator
journalctl -u p5-ci-orchestrator -f
```

Keep the service name `p5-ci-orchestrator`, since `setup.sh` stops and restarts a service with that name when it's re-run.

## Tests

```sh
cd orchestrator && npm test
./test/isolation.sh
```
