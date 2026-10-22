# Trying the Docker Cloud Sandboxes gateway

This branch runs the whole Hermes agent (chat, memory, skills, sessions, cron) in
a Docker Cloud Sandbox, with Hermes Desktop on your machine as the UI. You type a
Docker Hub username and a personal access token into Desktop; it creates the
sandbox, a persistent volume for Hermes state, and a signed-in gateway entry.

Background and design: [README.md](README.md).

## What you need

- A Docker account with **Cloud Sandboxes access, including volumes**. With the
  AlwaysOn and Hibernate entitlements the sandbox stays up around the clock;
  without them it sleeps once a day until something wakes it (see below).
- A Docker **personal access token** (PAT) for that account
  (Docker Hub → Account settings → Personal access tokens).
- An **Anthropic, OpenAI or OpenRouter API key** (step 4). Anthropic wins when
  several are set.
- macOS or Linux with `git` and Node `^22.22`, `^24.11` or `>=26`.
  Python is provisioned for you by `./activate`.
- Optional: the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/cloud/) 0.42.0 or
  later, for looking inside the sandbox.

## 1. Get the branch

```bash
git clone https://github.com/cdupuis/hermes-agent.git
cd hermes-agent
git checkout docker-sandboxes
```

## 2. Run Hermes Desktop from the branch

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

## 3. Create the gateway

1. In Desktop: **Settings → Gateways**.
2. Pick the **Docker Cloud Sandboxes** card (between Hermes Cloud and Remote gateway).
3. Enter your Docker Hub username and PAT, and click **Create gateway**.

The first run takes a few minutes, because Cloud pulls a ~1.5 GB image. The panel shows each
step (volume → sandbox → starting → port → first boot → ready). When it
finishes, Desktop switches to the new **Docker Sandbox** gateway, already
signed in.

## 4. Add your model key

In **Settings → Providers**, enter your Anthropic (or OpenAI / OpenRouter) API
key, as for any gateway. For a Docker Sandbox gateway, Desktop does not send the
key to the gateway: it stores it as a secret in your Docker account
(`hermes-desktop:anthropic`), and the Docker proxy swaps it in on the way to the
provider. The sandbox only ever sees a placeholder, so nothing the agent runs can
read the key.

Cloud attaches secrets only when it creates a sandbox, so the **first** key for a
provider rebuilds the sandbox on the same volume: the save takes a minute or
two, and the gateway reconnects by itself. Changing that key later updates the
secret in place, without a rebuild. Then chat as usual: the model calls, tools and
files all run in the sandbox.

Secrets stored with `sbx --cloud secret set` cannot be used: Cloud refuses to
attach them to a sandbox ("stored secret must be enrolled with an immutable
resource identity"). Store the key through Desktop instead.

## What to expect

- **A daily hibernate.** A cycle lasts at most 24 h. At its end Cloud hibernates
  the sandbox and, with the AlwaysOn and Hibernate entitlements, resumes it on
  its own: a memory snapshot, so running processes, the address and the login all
  survive, and the gateway is back within a minute or two. Without those
  entitlements the sandbox stays asleep until something wakes it; Desktop resumes
  it at launch and every 30 min while it runs. If the sandbox is ever lost,
  Desktop rebuilds it on the same volume (`Docker-Sandbox-hermes-home`), so
  memory, skills, sessions and cron jobs survive that too.
- **Scheduled jobs run in the cloud**, even when Desktop is closed, while the
  sandbox is awake: always with the entitlements, otherwise only until it goes
  to sleep. Jobs due while it is hibernated are missed.
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
| "No credentials" / the model never answers | No key yet: step 4. |
| Create times out at *starting* | Cold image pull; click Create again (it reuses the volume). |
| 401 from the model | The stored key is wrong: enter it again in Settings → Providers. |
| `409 sandbox is hibernated` | Asleep (no AlwaysOn entitlement); restart Desktop to wake it. |
| Login screen for the gateway | Session lapsed; wait for the keeper (≤ 30 min) or restart Desktop. |

## Cleaning up

Remove the gateway in **Settings → Gateways**. Within 30 minutes (or at the next
launch) Desktop deletes its sandbox, which no longer expires on its own, and stops
looking after it. The volume and the `hermes-desktop:*` secrets stay in your
account until you delete them; creating the gateway again picks the volume up.
