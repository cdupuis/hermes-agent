# syntax=docker/dockerfile:1.7
# Image for the `hermes-serve` sandbox kit: Hermes Agent as a headless backend
# (`hermes serve`) that Hermes Desktop connects to as a Remote gateway.
#
# Layout. Hermes' package manager keeps the checkout, the tool store and the
# committed dependency environment under one root (<root>/hermes-agent,
# <root>/tools, <root>/installs/<key>). That root is the BUILD-time
# HERMES_HOME, /home/agent/.hermes-install, and it stays in the image.
# Runtime state (config, .env, sessions, memory, skills, cron) lives in the
# RUNTIME HERMES_HOME, /home/agent/.hermes, which the provisioner mounts as a
# persistent volume; hermes-serve-bootstrap links <runtime>/installs to the
# image's committed environment on first boot so the launcher finds it.
ARG BASE_IMAGE=docker/sandbox-templates:shell
FROM ${BASE_IMAGE}

# Re-declared inside the stage: a pre-FROM ARG is visible only to FROM lines.
ARG BASE_IMAGE

# Empty resolves upstream's newest stable release at build time; a release tag
# pins it.
ARG HERMES_VERSION=""

# Cache key only: the releases feed changes on every published release, which
# is what invalidates the install layer below.
ADD --chmod=644 https://github.com/NousResearch/hermes-agent/releases.atom /tmp/hermes-releases.atom

ENV HERMES_INSTALL_ROOT=/home/agent/.hermes-install

USER agent
WORKDIR /home/agent/workspace

# install.sh from the resolved tag (not main) so installer and code match.
# --skip-browser/--skip-computer-use drop Playwright and the cua-driver fetch.
# The `anthropic` extra goes through `hermes pm` because this kit wires
# Anthropic up as a first-class provider and the image disables lazy installs
# below. `hermes --version` is the build-time gate.
RUN set -eu; \
    export HERMES_HOME="$HERMES_INSTALL_ROOT" PATH="$HOME/.local/bin:$PATH"; \
    tag="${HERMES_VERSION}"; \
    if [ -z "$tag" ]; then \
        tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/NousResearch/hermes-agent/releases/latest | sed -n 's#.*/releases/tag/##p')"; \
    fi; \
    if [ -z "$tag" ]; then \
        echo "Failed to resolve a hermes-agent release tag; pass --build-arg HERMES_VERSION=<tag>." >&2; \
        exit 1; \
    fi; \
    curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${tag}/scripts/install.sh" -o /tmp/hermes-install.sh; \
    chmod +x /tmp/hermes-install.sh; \
    /tmp/hermes-install.sh --branch "$tag" --skip-setup --skip-browser --skip-computer-use --non-interactive; \
    rm -f /tmp/hermes-install.sh; \
    hermes pm install --extra anthropic; \
    hermes --version; \
    mkdir -p /home/agent/.hermes

# Everything outside the baked extras is a lazy_deps entry Hermes would
# pip-install from PyPI at first use; refuse that outright (FeatureUnavailable
# names the missing extra) rather than hang against a blocked host.
# HERMES_RUNTIME_DIR: the PM tool store (node, ffmpeg, ripgrep, uv) stays in the
# image; without the override PM would look under the runtime HERMES_HOME.
ENV HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_HOME=/home/agent/.hermes \
    HERMES_RUNTIME_DIR=/home/agent/.hermes-install/tools

COPY --chmod=0755 scripts/hermes-start.sh /usr/local/bin/hermes-start
COPY --chmod=0755 scripts/hermes-credential-auth.sh /usr/local/bin/hermes-credential-auth
COPY --chmod=0755 scripts/hermes-serve-bootstrap.sh /usr/local/bin/hermes-serve-bootstrap

LABEL com.docker.sandboxes.flavor="hermes-serve"
LABEL com.docker.sandboxes.base="${BASE_IMAGE}"

USER agent
WORKDIR /home/agent/workspace
ENTRYPOINT ["/usr/local/bin/hermes-start"]
CMD ["serve", "--host", "0.0.0.0", "--port", "9119"]
