"""secret → volume → sandbox → port → login readout, resumable from the state file."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from hermes_sbx import kitpack
from hermes_sbx.state import BackendState

LOGIN_FILE = "/home/agent/.hermes/.sbx/desktop-login.json"
LOGIN_NONCE_ENV = "HSBX_LOGIN_NONCE"  # read by the kit's hermes-serve-bootstrap.sh; not a secret
DEFAULT_VOLUME_TARGET = "/home/agent/.hermes"
DEFAULT_PORT = 9119


@dataclass
class ProvisionConfig:
    name: str
    kit_dir: Path
    image: str | None = None
    resources: str = "small"
    volume_target: str = DEFAULT_VOLUME_TARGET
    port: int = DEFAULT_PORT
    anthropic_api_key: str | None = None
    secret_name: str | None = None  # an existing secrets/{id} to attach instead
    environment: dict[str, str] = field(default_factory=dict)
    lifecycle: dict[str, Any] | None = None
    wait_timeout: float = 600.0
    login_timeout: float = 180.0


class ProvisionError(RuntimeError):
    pass


def _digest(request: dict[str, Any]) -> str:
    """Stable short digest of a create request (bytes hashed, everything else repr'd sorted)."""
    h = hashlib.sha256()
    for key in sorted(request):
        value = request[key]
        h.update(key.encode())
        h.update(value if isinstance(value, bytes) else repr(sorted(value.items()) if isinstance(value, dict) else value).encode())
    return h.hexdigest()[:12]


class Provisioner:
    def __init__(self, backend, *, log: Callable[[str], None] = print,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic):
        self._backend = backend
        self._log = log
        self._sleep = sleep
        self._clock = clock

    @staticmethod
    def _request_id(name: str, step: str) -> str:
        return f"hermes-sbx:{name}:{step}"

    def up(self, cfg: ProvisionConfig, state: BackendState | None = None) -> BackendState:
        """Create what the state file does not already name; every step is idempotent."""
        state = state or BackendState(name=cfg.name)
        kit = kitpack.pack_dir(cfg.kit_dir, image=cfg.image)

        if not state.secret:
            if cfg.secret_name:
                state.secret = cfg.secret_name
            elif cfg.anthropic_api_key:
                state.secret = self._backend.create_secret(
                    display_name=f"{cfg.name}-anthropic", service_type="anthropic",
                    token=cfg.anthropic_api_key, request_id=self._request_id(cfg.name, "secret"))
                self._log(f"stored Anthropic key as {state.secret}")

        if state.sandbox and not self._backend.exists(state.sandbox):
            # Expired (deleted at timeout) or removed elsewhere: recreate on the same volume.
            self._log(f"{state.sandbox} is gone; recreating it on {state.volume}")
            state.sandbox, state.url = "", ""
        attach = self._secrets_to_attach(state, kit) if not state.sandbox else []

        if not state.volume:
            state.volume = self._backend.create_volume(
                display_name=f"{cfg.name}-hermes-home", request_id=self._request_id(cfg.name, "volume"))
            self._log(f"created volume {state.volume}")

        if not state.sandbox:
            # A fresh nonce makes the kit issue a new one-shot login, also on a reused volume whose
            # backend an earlier sandbox set up. It is kept in the state until the login is read, so
            # a retried create carries the same body and replays instead of conflicting.
            nonce = state.extra.setdefault("login_nonce", uuid.uuid4().hex)
            state.username, state.password = "", ""
            request = dict(
                display_name=cfg.name, kit_ref=kit["manifest"]["name"], artifact=kitpack.artifact_bytes(kit),
                resources=cfg.resources, volume=state.volume, volume_target=cfg.volume_target,
                secrets=attach,
                environment={**cfg.environment, LOGIN_NONCE_ENV: nonce}, lifecycle=cfg.lifecycle)
            # Cloud refuses a replayed key whose body changed (failedPrecondition, seen live), so the
            # key names the request: a retry of the same create replays, a changed one is new.
            state.sandbox = self._backend.create_sandbox(
                **request, request_id=self._request_id(cfg.name, f"sandbox:{_digest(request)}"))
            self._log(f"created sandbox {state.sandbox}")

        self._backend.wait_running(state.sandbox, timeout=cfg.wait_timeout)

        if not state.url:
            state.url = self._backend.publish_port(
                state.sandbox, number=cfg.port, request_id=self._request_id(cfg.name, "port"))
            self._log(f"published port {cfg.port} at {state.url}")

        if not state.password:
            login = self._read_login(state.sandbox, timeout=cfg.login_timeout)
            state.username, state.password = login["username"], login["password"]
            state.extra.pop("login_nonce", None)
            outcome = self._backend.run(state.sandbox, ["rm", "-f", LOGIN_FILE])
            if outcome.exit_code != 0:
                self._log(f"warning: could not remove {LOGIN_FILE} (exit {outcome.exit_code})")
        return state

    def _secrets_to_attach(self, state: BackendState, kit: dict) -> list[str]:
        """Declaring a credential in the kit is not enough: the account's stored secret must be
        attached at create, or the proxy injects nothing and every model call 401s (seen live).
        With no explicit secret, attach the account's own, one per service the kit declares."""
        if state.secret:
            return [state.secret]
        services = [c["service"] for c in kit.get("credentials", [])]
        picked: dict[str, str] = {}
        for name, service in self._backend.list_secrets():
            if service in services and service not in picked:
                picked[service] = name
        if not picked:
            raise ProvisionError(
                f"this Docker account has no stored {', '.join(services)} secret for the gateway to use; "
                "store one, or pass --store-key-env ANTHROPIC_API_KEY")
        self._log(f"attaching the account's {', '.join(picked)} secret(s)")
        return list(picked.values())

    def _read_login(self, sandbox: str, *, timeout: float) -> dict[str, str]:
        """The bootstrap writes the login once at first boot; it may not have run yet."""
        deadline = self._clock() + timeout
        while True:
            raw = self._backend.read_file(sandbox, LOGIN_FILE)
            if raw:
                try:
                    login = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise ProvisionError(f"{LOGIN_FILE} is not JSON: {exc}") from exc
                if login.get("username") and login.get("password"):
                    return login
            if self._clock() >= deadline:
                raise ProvisionError(
                    f"{LOGIN_FILE} did not appear within {timeout:.0f}s; the backend may have failed to boot "
                    f"(inspect with: sbx exec {sandbox} -- cat /home/agent/.hermes/logs/*.log)")
            self._sleep(2.0)

    def down(self, state: BackendState, *, delete_volume: bool = False, delete_secret: bool = False) -> None:
        if state.sandbox:
            self._backend.delete_sandbox(state.sandbox)
            self._log(f"deleted sandbox {state.sandbox}")
        if delete_volume and state.volume:
            self._backend.delete_volume(state.volume)
            self._log(f"deleted volume {state.volume} (all Hermes state is gone)")
        if delete_secret and state.secret:
            self._backend.delete_secret(state.secret)
            self._log(f"deleted secret {state.secret}")

    def status(self, state: BackendState) -> str:
        return self._backend.status(state.sandbox) if state.sandbox else "not created"


def desktop_connection(state: BackendState) -> dict[str, str]:
    """What to paste into Desktop → Settings → Gateways → Add connection → Remote gateway."""
    return {"url": state.url, "auth": "Sign in (username/password)",
            "username": state.username, "password": state.password}
