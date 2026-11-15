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

## Tests

```sh
cd orchestrator && npm test
./test/isolation.sh
```
