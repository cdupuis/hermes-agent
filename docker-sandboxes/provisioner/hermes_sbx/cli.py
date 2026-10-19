"""``hermes-sbx``: provision and manage a Hermes backend in a Docker Cloud Sandbox."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import timedelta
from pathlib import Path

from hermes_sbx import kitpack, sdk
from hermes_sbx.provision import ProvisionConfig, Provisioner, desktop_connection
from hermes_sbx.state import BackendState, default_state_dir, delete_state, load_state, save_state

DEFAULT_KIT_DIR = Path(__file__).resolve().parents[2] / "kit"


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--name", required=True, help="backend name (sandbox display name and state file)")
    parser.add_argument("--state-dir", type=Path, default=None,
                        help="where state files live (default ~/.hermes-sbx)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hermes-sbx", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    up = sub.add_parser("up", help="create (or resume creating) the backend and print the Desktop connection")
    _add_common(up)
    up.add_argument("--kit-dir", type=Path, default=DEFAULT_KIT_DIR)
    up.add_argument("--image", default=None, help="override the kit image reference")
    up.add_argument("--resources", default="small", help="micro|small|medium|large|xl (default small)")
    # By default the account's own anthropic credential is injected by the sandbox
    # proxy (the kit declares the service); these only matter when it is not.
    up.add_argument("--store-key-env", default=None, metavar="ENV_VAR",
                    help="store the Anthropic key found in ENV_VAR as a sandbox secret and attach it")
    up.add_argument("--secret", default=None, help="attach an existing secrets/{id}")
    up.add_argument("--lifetime-hours", type=float, default=24,
                    help="sandbox lifetime before --on-timeout applies (default and Cloud maximum: 24h)")
    up.add_argument("--on-timeout", choices=sdk.TIMEOUT_ACTIONS, default="delete",
                    help="what expiry does to the sandbox (default delete, the only action Cloud allows with a "
                         "volume; the volume survives and `up` recreates the sandbox on it)")
    up.add_argument("--wait-timeout", type=float, default=600.0)
    up.add_argument("--json", action="store_true", help="print the connection as JSON")

    down = sub.add_parser("down", help="delete the sandbox; keep the volume and secret unless told otherwise")
    _add_common(down)
    down.add_argument("--delete-volume", action="store_true", help="also delete the state volume (irreversible)")
    down.add_argument("--delete-secret", action="store_true")

    status = sub.add_parser("status", help="show the sandbox status and connection details")
    _add_common(status)
    status.add_argument("--json", action="store_true")

    renew = sub.add_parser("renew", help="extend the sandbox lifetime (run from cron to keep the backend up)")
    _add_common(renew)
    renew.add_argument("--lifetime-hours", type=float, default=24)

    pack = sub.add_parser("pack", help="print the inline v2 artifact for a kit directory")
    pack.add_argument("--kit-dir", type=Path, default=DEFAULT_KIT_DIR)
    pack.add_argument("--image", default=None)
    return parser


def _print_connection(state: BackendState, *, as_json: bool) -> None:
    conn = desktop_connection(state)
    if as_json:
        print(json.dumps(conn, indent=2))
        return
    print()
    print("Hermes Desktop → Settings → Gateways → Add connection → Remote gateway")
    print(f"  Gateway URL:  {conn['url']}")
    print(f"  Sign in as:   {conn['username']} / {conn['password']}")
    print(f"  Sandbox:      {state.sandbox}    volume: {state.volume}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "pack":
        print(json.dumps(kitpack.pack_dir(args.kit_dir, image=args.image), indent=2))
        return 0

    state_dir = args.state_dir or default_state_dir()
    state = load_state(state_dir, args.name)
    backend = sdk.Backend(sdk.make_client())
    prov = Provisioner(backend, log=lambda msg: print(msg, file=sys.stderr))

    if args.command == "up":
        key = os.environ.get(args.store_key_env) if args.store_key_env else None
        if args.store_key_env and not key:
            print(f"${args.store_key_env} is unset", file=sys.stderr)
            return 2
        cfg = ProvisionConfig(name=args.name, kit_dir=args.kit_dir, image=args.image, resources=args.resources,
                              anthropic_api_key=key, secret_name=args.secret,
                              lifecycle=sdk.lifecycle(lifetime=timedelta(hours=args.lifetime_hours),
                                                      on_timeout=args.on_timeout),
                              wait_timeout=args.wait_timeout)
        # up() fills this object in place, so a failure midway still leaves the names of
        # what it created for the save below (and for the next run to resume from).
        state = state or BackendState(name=args.name)
        try:
            prov.up(cfg, state)
        finally:
            save_state(state_dir, state)
        _print_connection(state, as_json=args.json)
        return 0

    if state is None:
        print(f"no state for {args.name!r} under {state_dir}", file=sys.stderr)
        return 1
    if args.command == "status":
        info = {"status": prov.status(state), **desktop_connection(state), "sandbox": state.sandbox,
                "volume": state.volume, "secret": state.secret}
        print(json.dumps(info, indent=2) if args.json else "\n".join(f"{k}: {v}" for k, v in info.items()))
        return 0
    if args.command == "renew":
        backend.renew(state.sandbox, lifetime=sdk.lifecycle(lifetime=timedelta(hours=args.lifetime_hours))["timeout"])
        print(f"{state.sandbox}: lifetime reset to {args.lifetime_hours:g}h", file=sys.stderr)
        return 0
    if args.command == "down":
        prov.down(state, delete_volume=args.delete_volume, delete_secret=args.delete_secret)
        if args.delete_volume:
            delete_state(state_dir, args.name)
        else:
            state.sandbox, state.url, state.username, state.password = "", "", "", ""
            save_state(state_dir, state)
            print(f"volume {state.volume} kept; `hermes-sbx up --name {args.name}` reattaches it", file=sys.stderr)
        return 0
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
