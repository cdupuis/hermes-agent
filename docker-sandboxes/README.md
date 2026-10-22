# Hermes Agent on Docker Cloud Sandboxes

Run the whole Hermes agent — gateway, cron, memory, skills, sessions — inside a
[Docker Cloud Sandbox](https://docs.docker.com/ai/sandboxes/), and use Hermes
Desktop as the UI. Desktop already talks to any `hermes serve` backend over
HTTP + WebSocket ("Remote gateway" in **Settings → Gateways**); this directory
provides what makes a sandbox such a backend, plus a Desktop card that creates
one in a single step (to try it, follow [TRY_IT.md](TRY_IT.md)):

| Piece | What it is |
|---|---|
| [`kit/`](kit/) | A v2 sandbox kit: image build (`Dockerfile`), the `spec.yaml` the Sandboxes API applies at create, and the scripts that boot `hermes serve` with the proxy-managed provider credential and a generated dashboard login. |
| [`provisioner/`](provisioner/) | `hermes-sbx`, a small Python CLI on the [`docker-sandboxes-api`](https://github.com/docker/sandboxes-api) SDK: stores the Anthropic key as a sandbox secret, creates a persistent volume for `HERMES_HOME`, creates the sandbox from the kit, publishes port 9119, reads the generated login back out, and prints what to paste into Desktop. |
| Desktop card | **Settings → Gateways → Docker Cloud Sandboxes** (`apps/desktop/electron/docker-sandboxes-*.ts`, `src/app/settings/docker-sandboxes-panel.tsx`): asks for a Docker username and a PAT, runs the same flow as `hermes-sbx` on the [`@docker/sandboxes`](https://www.npmjs.com/package/@docker/sandboxes) SDK, and saves the result as an ordinary Remote gateway that is already signed in. The PAT is kept (keychain-encrypted) so Desktop can wake the sandbox, rebuild a lost one and store the gateway's model keys as Docker secrets. |
| [`tools/`](tools/) | `kitpack-go`, the reference packer from `docker/sbx-kits-contrib`, used to generate the goldens that pin the Python packer. |

## How the pieces fit

```
Hermes Desktop ──HTTPS/WSS──▶ published port 9119 ──▶ hermes serve (sandbox)
                                                        │  HERMES_HOME=/home/agent/.hermes   ← managed volume
                                                        │  ANTHROPIC_API_KEY=<sentinel>      ← proxy swaps in the real key
                                                        └──▶ api.anthropic.com
```

- **State outlives the sandbox.** `HERMES_HOME` is a managed `volumes/{id}`
  resource attached at `/home/agent/.hermes`. `hermes-sbx down` deletes the
  sandbox and keeps the volume; the next `up` reattaches it. The image keeps
  the checkout, the tool store and the committed dependency environment under
  a separate root (`/home/agent/.hermes-install`, the build-time
  `HERMES_HOME`) so the mount cannot shadow them; first boot links
  `<volume>/installs` to that environment so the `hermes` launcher finds it.
- **The model key never enters the sandbox.** The kit declares `anthropic`,
  `openai` and `openrouter` credentials, and the provisioner ATTACHES stored
  secrets for those services at create (`storage.secrets`). Both are needed: an
  unattached secret is never injected, the container's `ANTHROPIC_API_KEY`
  stays the `proxy-managed` sentinel, and every model call answers 401.
  Attached, the proxy swaps the sentinel for the key on egress and Cloud sets
  `SBX_CRED_<SERVICE>_MODE`, which the kit's credential script reads to keep the
  sentinel. Only secrets created through the API attach: one stored by `sbx`
  is refused ("stored secret must be enrolled with an immutable resource
  identity", since 2026-10-22). So Desktop stores the key itself: a save in
  **Settings → Providers** for a Docker Sandbox gateway becomes the secret
  `hermes-desktop:<service>` in the Docker account instead of a line in the
  gateway's `.env` (`docker-sandboxes-provider-keys.ts`). A changed key is
  updated in place; the first key for a provider rebuilds the sandbox on the
  same volume, because Cloud attaches secrets only at create. `hermes-sbx`
  attaches those same secrets, or one it stores with
  `--store-key-env ANTHROPIC_API_KEY`.
- **The published URL is public HTTPS**, so the backend's own auth gate is on:
  a non-loopback bind in Hermes always requires an auth provider. Every
  provisioning request sets a fresh, non-secret `HSBX_LOGIN_NONCE` in the
  sandbox environment; when it differs from the one last served, the kit's
  bootstrap issues a new password (hashed in `HERMES_HOME/.env`, signing
  secret kept so live sessions survive) and writes the plaintext once to
  `HERMES_HOME/.sbx/desktop-login.json`. The provisioner reads and deletes that
  file. This works the same on a fresh volume and on one an earlier sandbox set
  up; restarts of the same sandbox rotate nothing.
- **The backend is the kit's entrypoint**, which Cloud runs at create; a
  `setup.startup` hook runs the gateway that owns cron beside it.
- **The sandbox hibernates in place.** The volume is attached `exclusive`, which
  lets Cloud snapshot the whole sandbox. Each cycle lasts the 24h maximum; with
  `onTimeout: restart` Cloud then hibernates and resumes it (processes, memory,
  URL and login intact). Accounts without the AlwaysOn and Hibernate
  entitlements get `stop` + auto-resume: asleep until woken.

## Build and publish the image

```bash
cd docker-sandboxes/kit
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<you>/hermes-serve-image:latest --push .
# pin a Hermes release instead of "latest stable": --build-arg HERMES_VERSION=v0.9.0
```

Point `sandbox.image` in `kit/spec.yaml` at your reference, or pass
`--image` to `hermes-sbx up`.

## Provision a backend

```bash
cd docker-sandboxes/provisioner
pip install -e .   # pulls the SDK from github.com/docker/sandboxes-api (not on PyPI yet), pinned by SHA
export DOCKER_USERNAME=<you> DOCKER_PAT=<docker-personal-access-token>   # or DOCKER_ACCESS_TOKEN

hermes-sbx up --name my-hermes --image ghcr.io/<you>/hermes-serve-image:latest
# attaches the hermes-desktop:<service> secrets Desktop stored; without them,
# add --store-key-env ANTHROPIC_API_KEY (secrets stored by `sbx` cannot be attached)
```

Prints, at the end:

```
Hermes Desktop → Settings → Gateways → Add connection → Remote gateway
  Gateway URL:  https://<sandbox>-9119.<region>.sandboxes.docker.com
  Sign in as:   hermes / <generated password>
```

Every step is idempotent and recorded in `~/.hermes-sbx/<name>.json` (0600; it
holds the login). Re-running `up` after a failure resumes where it stopped.
Other commands: `status`, `renew`, `down [--delete-volume] [--delete-secret]`,
`pack` (print the inline artifact).

## The kit, for `sbx` users

The same kit runs with the CLI (`sbx run --kit ./docker-sandboxes/kit hermes-serve`),
but then there is no managed volume: state lives in the sandbox's own disk.
The kit is deliberately **v2** (`schemaVersion: "2"`): the public Cloud API
accepts v2 artifacts inline at create (that is how the SDK's own bundled
catalog launches), while v3 descriptor/reference inputs are not in the public
profile yet. Moving to v3 later is a grammar change only — the Dockerfile and
scripts carry over.

## Limits and open questions

Verified against Cloud (2026-10): sign-in, the `/api/ws` WebSocket upgrade
through the port proxy, credential injection with the secret attached (the
sentinel reaches api.anthropic.com as the real key: 200; unattached: 401),
volume persistence across sandbox deletion, and (2026-10-22) hibernate and
resume with the volume attached: stop in about 60 s, start in about 14 s, the
same boot, processes, temp files, volume and published URL afterwards; while
asleep the URL answers `409 sandbox is hibernated`.

- **A daily hibernate.** A cycle lasts at most 24h ("timeout duration is
  outside the supported range" beyond it). With `restart` the sandbox resumes
  by itself; how long the gateway is unreachable during that daily cycle was not
  measured. With `stop` it sleeps until Desktop's keeper (at launch, then every
  30 min) or `hermes-sbx up` resumes it. A sandbox that is really gone is
  rebuilt on the same volume (display names are unique per account, so the
  same name finds it); that one gets a new URL, and Desktop re-points the
  gateway entry. Removing the gateway in Desktop deletes its sandbox, which
  would otherwise never expire.
- **Cron runs in the sandbox, not in Desktop.** `hermes serve` only ticks cron
  when Desktop owns the process, so the kit runs a supervised `hermes gateway
  run` beside it (a startup hook; a hand-run gateway never idle-exits), and
  `hermes cron status` reports "the host gateway … serving profiles default".
  Without it jobs fired only while a client happened to start a gateway.
- **Cron sleeps with the sandbox.** Jobs due while it is hibernated are
  missed: briefly once a day with `restart`, until woken with `stop`. A
  `CronScheduler` provider that arms wake-ups externally is the follow-up if
  sleeping sandboxes matter.
- **Volume access must be enabled** for the Docker account; memory-snapshot
  images do not support volume attachment. Volumes mount root-owned; the kit
  re-owns the mount root.
- **The image is single-arch** (built on arm64) until CI publishes a
  multi-arch one; Cloud schedules it on arm64 automatically.
- Only Anthropic, OpenAI and OpenRouter are baked in and reachable; lazy
  `pip install` of other providers is disabled in the image.

## Development

```bash
cd docker-sandboxes/provisioner && pip install -e . pytest && pytest
cd docker-sandboxes/tools && ./regenerate-goldens.sh   # after editing kit/spec.yaml
# then copy provisioner/tests/golden/hermes-serve.json into
# apps/desktop/electron/docker-sandboxes-kit.ts (a test fails until you do)
cd apps/desktop && npx vitest run --project electron electron/docker-sandboxes
cd apps/desktop && npx vitest run --project ui src/app/settings/docker-sandboxes-panel.test.tsx
```
