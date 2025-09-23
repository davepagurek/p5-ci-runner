Install deps:
```sh
sudo apt  install docker.io
```

```sh
# Make sure the docker group exists
sudo groupadd docker || true

# Add your user to the docker group
sudo usermod -aG docker $USER

# Apply changes immediately
newgrp docker
```

Build the image (from the root of this repo):
```sh
docker build -t p5-ci-runner runner
```

Run the image manually:
```sh
docker run --rm -it \
  -e GITHUB_URL=https://github.com/<owner>/<repo> \
  -e GITHUB_TOKEN=<registration_token> \
  --device /dev/dri:/dev/dri \
  p5-ci-runner
```

...or if you have an nvidia GPU:
```sh
docker run --rm -it \
  -e GITHUB_URL=https://github.com/<owner>/<repo> \
  -e GITHUB_TOKEN=<registration_token> \
  --gpus all \
  p5-ci-runner
```

Orchestrator:
- Get an access token from https://github.com/settings/tokens by going to:
  - Generate Token (Classic)
  - Adding `repo` and `workflow` permissions

Run with:
```
GPU_MODE=dri OWNER=processing REPO=p5.js PAT=your_token_here node server.mjs
```

Use `GPU_MODE=nvidia` if using an nvidia GPU.
