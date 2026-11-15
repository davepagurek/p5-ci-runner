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

Add `--daemon` to the setup command. It prompts for the owner, repo and token (stored in `/etc/p5-ci-orchestrator.env`, readable by root only), and installs a systemd service for the orchestrator plus a weekly timer that rebuilds the runner image so it stays up to date. Needs Node.js 18+ on the host.

```sh
sudo ./setup.sh --daemon
```

Use `--reconfigure` to be prompted for the owner, repo and token again. Check on it with:
```sh
systemctl status p5-ci-orchestrator
journalctl -u p5-ci-orchestrator -f
```

To rebuild the runner image only, immediately: `sudo ./update-image.sh`.

## Tests

```sh
cd orchestrator && npm test
./test/isolation.sh
```
