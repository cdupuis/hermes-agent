#!/bin/sh
# Boot-time seeding of HERMES_HOME for the headless backend. Idempotent.
#
# 1. Dependency environment. Hermes' package manager scopes its committed
#    environment per data root (<HERMES_HOME>/installs/<key>). The image built
#    it under HERMES_INSTALL_ROOT; a runtime HERMES_HOME on a fresh volume has
#    none, so link the image's in. (Newer Hermes borrows the owner root by
#    itself; the link keeps the released versions working too.)
# 2. Dashboard auth. `hermes serve` bound to a non-loopback address refuses to
#    start without an auth provider, so keep a username/password in
#    $HERMES_HOME/.env (hashed; the plaintext never sits at rest there).
#
#    The plaintext is handed out exactly once per provisioning request: the
#    provisioner sets a fresh HSBX_LOGIN_NONCE in the sandbox environment, and
#    when it differs from the nonce last served the password is (re)generated
#    and written to $HERMES_HOME/.sbx/desktop-login.json (0600) for the
#    provisioner to read through the files API and then delete. A new sandbox
#    on an existing volume (a gateway recreated after its sandbox expired) so
#    gets a usable login too, while restarts of the same sandbox rotate nothing.
#    The signing secret is kept across rotations, so live sessions survive.
set -eu

HOME="${HOME:-/home/agent}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_INSTALL_ROOT="${HERMES_INSTALL_ROOT:-$HOME/.hermes-install}"
CHECKOUT="$HERMES_INSTALL_ROOT/hermes-agent"
ENV_FILE="$HERMES_HOME/.env"
SBX_DIR="$HERMES_HOME/.sbx"
LOGIN_FILE="$SBX_DIR/desktop-login.json"
NONCE_FILE="$SBX_DIR/login-nonce"
NONCE="${HSBX_LOGIN_NONCE:-}"

umask 077
mkdir -p "$HERMES_HOME" "$SBX_DIR"

if [ ! -e "$HERMES_HOME/installs" ] && [ -d "$HERMES_INSTALL_ROOT/installs" ]; then
    ln -s "$HERMES_INSTALL_ROOT/installs" "$HERMES_HOME/installs"
fi

env_value() {
    # Always succeeds (empty when unset): callers assign it under `set -e`, and a
    # fresh volume has no .env yet.
    if [ -f "$ENV_FILE" ]; then
        sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
    fi
}

have_login=0
[ -n "$(env_value HERMES_DASHBOARD_BASIC_AUTH_USERNAME)" ] && have_login=1
served_nonce="$(cat "$NONCE_FILE" 2>/dev/null || true)"

if [ "$have_login" = 1 ] && { [ -z "$NONCE" ] || [ "$NONCE" = "$served_nonce" ]; }; then
    exit 0
fi

# The committed dependency environment's interpreter (facts.json names it; the
# store's bare Python has no packages). hash_password lives in the checkout's
# plugins package, the documented operator one-liner runs it there too.
PYTHON=""
for facts in "$HERMES_INSTALL_ROOT"/installs/*/facts.json; do
    [ -f "$facts" ] || continue
    env_dir="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["venv"]["environment"])' "$facts" 2>/dev/null)" || continue
    [ -x "$env_dir/bin/python" ] && PYTHON="$env_dir/bin/python" && break
done
if [ -z "$PYTHON" ]; then
    echo "hermes-serve-bootstrap: no committed dependency environment under $HERMES_INSTALL_ROOT/installs" >&2
    exit 1
fi

random_token() {
    # 32 bytes -> 43 url-safe chars; safe in .env and in JSON.
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
}

username=hermes
password="$(random_token)"
secret="$(env_value HERMES_DASHBOARD_BASIC_AUTH_SECRET)"
[ -n "$secret" ] || secret="$(random_token)"
hash="$(cd "$CHECKOUT" && PYTHONPATH="$CHECKOUT" "$PYTHON" -c \
    'import sys; from plugins.dashboard_auth.basic import hash_password; print(hash_password(sys.argv[1]))' "$password")"

# Replace our three keys in place; every other .env line is the user's.
tmp="$ENV_FILE.tmp.$$"
if [ -f "$ENV_FILE" ]; then
    grep -v -e '^HERMES_DASHBOARD_BASIC_AUTH_USERNAME=' -e '^HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=' \
        -e '^HERMES_DASHBOARD_BASIC_AUTH_SECRET=' \
        -e '^# Dashboard auth for the Desktop Remote-gateway connection' "$ENV_FILE" > "$tmp" || true
else
    : > "$tmp"
fi
{
    printf '# Dashboard auth for the Desktop Remote-gateway connection (managed by hermes-serve-bootstrap)\n'
    printf 'HERMES_DASHBOARD_BASIC_AUTH_USERNAME=%s\n' "$username"
    printf 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=%s\n' "$hash"
    printf 'HERMES_DASHBOARD_BASIC_AUTH_SECRET=%s\n' "$secret"
} >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

printf '{"username":"%s","password":"%s"}\n' "$username" "$password" > "$LOGIN_FILE"
chmod 600 "$LOGIN_FILE"
[ -n "$NONCE" ] && printf '%s\n' "$NONCE" > "$NONCE_FILE"
echo "hermes-serve-bootstrap: issued dashboard credentials; plaintext login at $LOGIN_FILE (read it once, then delete it)"
