# Trying the Docker Cloud Sandboxes gateway

This branch runs the whole Hermes agent (chat, memory, skills, sessions, cron) in
a Docker Cloud Sandbox, with Hermes Desktop on your machine as the UI. You type a
Docker Hub username and a personal access token into Desktop; it creates the
sandbox, a persistent volume for Hermes state, and a signed-in gateway entry.

Background and design: [README.md](README.md).

## What you need

- A Docker account with **Cloud Sandboxes access, including volumes**.
- A Docker **personal access token** (PAT) for that account
  (Docker Hub → Account settings → Personal access tokens).
- An **Anthropic API key stored as a secret in that Docker account** (step 2).
  OpenAI or OpenRouter secrets also work; Anthropic wins when several exist.
- macOS or Linux with `git` and Node `^22.22`, `^24.11` or `>=26`.
  Python is provisioned for you by `./activate`.
- The [`sbx` CLI](https://docs.docker.com/ai/sandboxes/cloud/) 0.42.0 or later.

## 1. Get the branch

```bash
git clone https://github.com/cdupuis/hermes-agent.git
cd hermes-agent
git checkout docker-sandboxes
```

## 2. Store your model key in your Docker account (once)

The key never goes into Desktop or the sandbox: the sandbox gets a placeholder,
and the Docker proxy swaps in the real key on its way to api.anthropic.com.
Desktop refuses to create a gateway if your account has no
`anthropic` / `openai` / `openrouter` cloud secret.

With the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/cloud/) (0.42.0 or later):

```bash
sbx login                              # same Docker account as in Desktop
sbx --cloud diagnose                   # checks Cloud access for the account
sbx --cloud secret set anthropic       # prompts for the key
```

`--cloud` matters: secrets stored for local sandboxes are not visible to cloud
sandboxes. For OpenAI or OpenRouter, use `openai` or `openrouter` as the service.

## 3. Run Hermes Desktop from the branch

From the repository root, use an isolated Hermes home, so your normal
`~/.hermes` is untouched:

```bash
export HERMES_HOME="$HOME/hermes-sbx-dev"
export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"
source ./activate                 # first run provisions Python + deps; takes a few minutes
npm ci                            # JS workspaces, once
HERMES_DESKTOP_PYTHON="$(command -v python3)" npm run dev --workspace apps/desktop
```

`HERMES_DESKTOP_PYTHON` makes the dev app use this checkout's runtime. Without
it, Desktop can pick up an older installed Hermes, and the UI loops on
"retry" (`hermes gateway ensure … exit 2` in the logs).

## 4. Create the gateway

1. In Desktop: **Settings → Gateways**.
2. Pick the **Docker Cloud Sandboxes** card (between Hermes Cloud and Remote gateway).
3. Enter your Docker Hub username and PAT, and click **Create gateway**.

The first run takes a few minutes, because Cloud pulls a ~1.5 GB image. The panel shows each
step (volume → sandbox → starting → port → first boot → ready). When it
finishes, Desktop switches to the new **Docker Sandbox** gateway, already
signed in. Chat as usual: the model calls, tools and files all run in the sandbox.

## What to expect

- **24-hour sandboxes.** Cloud deletes a sandbox after at most 24 h. While
  Desktop is running, it recreates the sandbox about 35 minutes before expiry
  on the same volume, repoints the gateway and signs in again. It checks at
  launch and then every 30 min. If Desktop was closed when the sandbox
  expired, the launch recreates it: the gateway reconnects on its own after a
  few minutes (the new sandbox has to boot), with no sign-in needed. Memory, skills, sessions and
  cron jobs live on the volume (`Docker-Sandbox-hermes-home`), so nothing is lost.
- **Scheduled jobs run in the cloud**, even when Desktop is closed, as long as
  the sandbox exists. Jobs due while no sandbox exists (Desktop closed past
  the 24 h mark) are missed.
- **Your PAT and the generated gateway password** are stored encrypted with
  the OS keychain in Desktop's user data (`docker-sandboxes.json`). If the
  keychain is unavailable, the panel tells you the gateway won't be kept alive.
- Models: Anthropic → `claude-opus-5-5`, otherwise OpenRouter or OpenAI.
  Switching the model with `/model` or in Settings sticks.
- Only Anthropic, OpenAI and OpenRouter are reachable from the sandbox; other
  providers and on-demand `pip install`s are disabled in the image.

## Looking inside / troubleshooting

With the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/):

```bash
sbx --cloud exec -it <sandbox-id> /bin/bash     # id: the "sandbox" field in Desktop's docker-sandboxes.json
tail -f ~/.hermes/logs/*.log                    # backend + gateway-run.log (cron)
hermes cron status                              # should say a gateway serves profile 'default'
```

| Symptom | Likely cause |
|---|---|
| "no model secret" before anything is created | Step 2 not done for this Docker account. |
| Create times out at *starting* | Cold image pull; click Create again (it reuses the volume). |
| 401 from the model | The secret is not of service type `anthropic`/`openai`/`openrouter`. |
| Login screen for the gateway | Session lapsed; wait for the keeper (≤ 30 min) or restart Desktop. |

## Cleaning up

Remove the gateway in **Settings → Gateways**; Desktop then stops recreating
it, and Cloud deletes the sandbox at its expiry (or delete it now with the `sbx` CLI).
The volume and the secret stay in your account until you delete them.
