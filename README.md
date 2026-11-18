## Setup

Clone this repo into your server. Copy the .pem file for your app installation into the folder.

Then, from the root of the repo, run:

```sh
sudo ./setup.sh
```

...or with an NVIDIA GPU:
```sh
sudo ./setup.sh --nvidia
```

Re-run it after changing anything in `proxy/` or `runner/` (e.g. `proxy/allowed_domains.txt`). Use `--recreate-network` if you change network settings.

## Orchestrator

The orchestrator registers runners for a GitHub organization, authenticating as a GitHub App owned by that organization (see below for how to create one).

```sh
cd orchestrator
GPU_MODE=dri OWNER=processing APP_CLIENT_ID=Iv23liAbCdEf1234 APP_PRIVATE_KEY_PATH=/path/to/key.pem node server.mjs
```

Use `GPU_MODE=nvidia` if using an nvidia GPU. Set `RUNNER_GROUP="group name"` to register into a specific runner group instead of the org's Default group.

## Creating a GitHub App

This is set up only to work with a GitHub org.

1. In the organization's settings, go to Developer settings, GitHub Apps, then New GitHub App
2. Give it any name + homepage URL
3. Uncheck "Active" under Webhook
4. Under Organization permissions, set "Self-hosted runners" to "Read and write"
5. Under "Where can this GitHub App be installed?", choose "Only on this account"
6. Click Create GitHub App. **Copy the client ID!**
7. It should say at the top, "Registration successful. You must generate a private key in order to install your GitHub App." Click the link to generate a key
8. Click New Key, which downloads a PEM file. Copy that to the server you're running it on
9. In the sidebar, click Install App, and install it on the organization

Then, in the sidebar, go to Actions and then Runner groups. Create a group (e.g. `p5-webgpu`), change it to "Selected Repositories", and then click the gear icon (the text is inexplicably not part of the button) to pick the repo it should have access to. Turn on "Allow public repositories" if the repo is public so jobs don't stay queued. **Remember the group's name! This will be set as `RUNNER_GROUP`.**

## Running automatically at startup

Add `--daemon` to the setup command, with the name of the runner group you created (leave `--runner-group` off to use the org's Default group). It prompts for the organization, GitHub App client ID and private key file (stored in `/etc/p5-ci-orchestrator.env` and `/etc/p5-ci-orchestrator.pem`, readable only by the service user), and installs a systemd service for the orchestrator plus a weekly timer that rebuilds the runner image so it stays up to date. Needs Node.js 18+ on the host.

```sh
sudo ./setup.sh --daemon --runner-group p5-webgpu
```

Use `--reconfigure` to be prompted for the organization and app again. Check on it with:
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
