#!/bin/sh
# Adapted from the `hermes-agent` kit in docker/sbx-kits-contrib (Apache-2.0),
# minus its Copilot handling. Resolve which Anthropic wire format Hermes should
# use and record it in an env file the entrypoint and `sbx exec` shells
# source; pin the provider in config.yaml for the one case auto-detection
# cannot see.
#
# Anthropic rejects an OAuth token presented as `x-api-key` and an API key
# presented as `Authorization: Bearer`, so the credential's shape decides the
# request Hermes emits. Hermes picks it from where the token resolves
# (agent/anthropic_credentials.py): ANTHROPIC_TOKEN / CLAUDE_CODE_OAUTH_TOKEN,
# then ANTHROPIC_API_KEY, then ~/.claude/.credentials.json. The kit's apiKey
# block sets ANTHROPIC_API_KEY to the proxy-managed sentinel unconditionally,
# and a non-empty value there shadows any discovered OAuth credential, so on an
# OAuth host the sentinel has to go.
#
# The discriminator is the materialized credential file, not
# SBX_CRED_ANTHROPIC_MODE: that variable reports "none" both for an OAuth login
# and for no credential at all.
#
# Provider selection is a separate problem: resolve_provider() picks OpenRouter
# over everything else the moment OPENAI_API_KEY or OPENROUTER_API_KEY looks
# like a usable secret, and both sentinels are present whether or not the host
# bound either service. So unset whichever the host did not bind
# (SBX_CRED_*_MODE is the proxy's own signal), and pin Anthropic in config.yaml
# for an OAuth login, which auto-detection has no tier for.
set -eu

# Startup hooks run with a minimal environment and no $HOME.
HOME="${HOME:-/home/agent}"

STATE_DIR="${HERMES_HOME:-$HOME/.hermes}"
AUTH_ENV_FILE="$STATE_DIR/credential-auth.env"
HERMES_BIN="$HOME/.local/bin/hermes"
# Must match credentials[].oauth.sentinels.accessToken in spec.yaml.
OAUTH_SENTINEL=sk-ant-oat01-proxy-managed

mkdir -p "$STATE_DIR"
rm -f "$AUTH_ENV_FILE"

#   oauth         -> drop the sentinel so Hermes reads ~/.claude/.credentials.json
#   apikey        -> leave the injected ANTHROPIC_API_KEY sentinel alone
#   no credential -> drop the sentinel too, or Hermes reports an invalid key
#                    for a credential that never existed
if grep -qF "$OAUTH_SENTINEL" "$HOME/.claude/.credentials.json" 2>/dev/null; then
    anthropic_cred=oauth
    printf 'unset ANTHROPIC_API_KEY\n' >> "$AUTH_ENV_FILE"
elif [ "${SBX_CRED_ANTHROPIC_MODE:-none}" = none ]; then
    anthropic_cred=none
    printf 'unset ANTHROPIC_API_KEY\n' >> "$AUTH_ENV_FILE"
else
    anthropic_cred=apikey
fi

if [ "${SBX_CRED_OPENAI_MODE:-none}" = none ]; then
    openai_bound=0
    printf 'unset OPENAI_API_KEY\n' >> "$AUTH_ENV_FILE"
else
    openai_bound=1
fi
if [ "${SBX_CRED_OPENROUTER_MODE:-none}" = none ]; then
    openrouter_bound=0
    printf 'unset OPENROUTER_API_KEY\n' >> "$AUTH_ENV_FILE"
else
    openrouter_bound=1
fi

# `sbx exec` runs a non-login shell, so a scripted call picks this up only when
# it asks for one (`sbx exec -- sh -lc 'hermes ...'`).
if [ -s "$AUTH_ENV_FILE" ]; then
    if ! grep -qF "$AUTH_ENV_FILE" "$HOME/.profile" 2>/dev/null; then
        printf '[ -f %s ] && . %s\n' "$AUTH_ENV_FILE" "$AUTH_ENV_FILE" >> "$HOME/.profile"
    fi
else
    rm -f "$AUTH_ENV_FILE"
fi

# Provider pin. The config template ships `provider: "auto"` with model
# `anthropic/claude-opus-4.6`, an OpenRouter-style id. Left on "auto" with more
# than one provider bound, resolve_provider() can land on OpenAI and ask it for
# that Anthropic model (seen live: every turn fails). So whenever the pair is
# still one this script could have produced, pin a provider + model that match,
# preferring Anthropic, then OpenRouter (where the template's id is valid), then
# OpenAI. A choice the user made with `hermes model` survives untouched.
if [ -x "$HERMES_BIN" ] && [ -w "$STATE_DIR" ]; then
    PRISTINE_PROVIDER=auto
    PRISTINE_MODEL='anthropic/claude-opus-4.6'
    ANTHROPIC_MODEL=claude-opus-5-5
    OPENAI_MODEL=gpt-6-luna

    current_provider=$("$HERMES_BIN" config get model.provider 2>/dev/null) || current_provider=""
    current_model=$("$HERMES_BIN" config get model.default 2>/dev/null) || current_model=""

    # Every pair an earlier version of this script (or the template) wrote.
    ours=0
    case "$current_provider/$current_model" in
        "/" | "auto/$PRISTINE_MODEL" | "auto/" | "anthropic/claude-opus-4-6" | "anthropic/$ANTHROPIC_MODEL" | \
            "openrouter/$PRISTINE_MODEL" | "openai-api/$OPENAI_MODEL") ours=1 ;;
    esac

    if [ "$ours" = 1 ]; then
        if [ "$anthropic_cred" != none ]; then
            want_provider=anthropic want_model=$ANTHROPIC_MODEL
        elif [ "$openrouter_bound" = 1 ]; then
            want_provider=openrouter want_model=$PRISTINE_MODEL
        elif [ "$openai_bound" = 1 ]; then
            want_provider=openai-api want_model=$OPENAI_MODEL
        else
            want_provider=$PRISTINE_PROVIDER want_model=$PRISTINE_MODEL
        fi
        [ "$current_provider" = "$want_provider" ] || "$HERMES_BIN" config set model.provider "$want_provider" >/dev/null 2>&1 || true
        [ "$current_model" = "$want_model" ] || "$HERMES_BIN" config set model.default "$want_model" >/dev/null 2>&1 || true
    fi
fi
