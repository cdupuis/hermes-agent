#!/bin/sh
# Starts the backend. Waits for the state volume, seeds first-boot state,
# sources the resolved credential env, then execs hermes with the given
# arguments (the image CMD is `serve --host 0.0.0.0 --port 9119`).
#
# The kit entrypoint: Cloud runs it when the sandbox starts, `sbx run` when it
# attaches, `docker run` as the image CMD. When a backend already answers on
# the port (an attach to a running sandbox), follow its logs instead of
# starting a second one.
set -u

HOME="${HOME:-/home/agent}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PORT=9119
export HOME HERMES_HOME

if [ "${1:-}" = serve ] && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then
    echo "hermes-start: backend already running on :$PORT; following its log (Ctrl-C detaches, the backend keeps running)"
    exec tail -n 50 -F "$HERMES_HOME"/logs/*.log
fi

# Without a volume (plain `sbx run`) the directory does not exist in the image.
mkdir -p "$HERMES_HOME" 2>/dev/null || true

# A freshly allocated volume can come up root-owned; the kit's root startup hook
# re-owns it, but hooks do not gate each other, so wait for it here.
waited=0
while ! [ -w "$HERMES_HOME" ]; do
    if [ "$waited" -ge 60 ]; then
        echo "hermes-start: $HERMES_HOME is not writable after ${waited}s; is the volume mounted and re-owned to agent?" >&2
        exit 1
    fi
    sleep 1
    waited=$((waited + 1))
done

# Bootstrap first: it links the dependency environment the `hermes` launcher
# needs. Both are idempotent.
sh /usr/local/bin/hermes-serve-bootstrap
sh /usr/local/bin/hermes-credential-auth

AUTH_ENV_FILE="$HERMES_HOME/credential-auth.env"
# shellcheck source=/dev/null
[ -f "$AUTH_ENV_FILE" ] && . "$AUTH_ENV_FILE"

# As PID 1 (plain `docker run`) hermes would have to reap orphans itself.
if [ "$$" = 1 ] && command -v tini >/dev/null 2>&1; then
    exec tini -- "$HOME/.local/bin/hermes" "$@"
fi
exec "$HOME/.local/bin/hermes" "$@"
