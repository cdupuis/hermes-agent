"""The one module that speaks to ``docker_sandboxes_api``.

``Backend`` reduces the SDK to the handful of calls the provisioner needs, so the
flow in :mod:`hermes_sbx.provision` tests against a fake and this adapter tests the
request shapes it hands the SDK. Method signatures follow the SDK README and the
cookbook snippets in docker/sbx-api (``cookbook/snippets/python``).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

SANDBOX_KIND = "sandbox"

# Named compute sizes. Only ``small`` (2 vCPU, 4 GiB) is documented; the others follow
# the same doubling up to the composition's 16 vCPU / 32 GiB ceiling.
COMPUTE_SIZES = {"micro": (1, 2048), "small": (2, 4096), "medium": (4, 8192), "large": (8, 16384),
                 "xl": (16, 32768)}


class AuthError(RuntimeError):
    pass


def _sdk():
    try:
        import docker_sandboxes_api
    except ImportError as exc:  # pragma: no cover - exercised only without the SDK
        raise RuntimeError("pip install docker-sandboxes-api") from exc
    from docker_sandboxes_api import models, sandboxes_client

    return SimpleNamespace(models=models, client=sandboxes_client)


def make_client(env: dict[str, str] | None = None):
    """A ``SyncSandboxesClient`` from ``DOCKER_ACCESS_TOKEN`` or ``DOCKER_USERNAME`` + ``DOCKER_PAT``."""
    env = os.environ if env is None else env
    token = env.get("DOCKER_ACCESS_TOKEN")
    username, pat = env.get("DOCKER_USERNAME"), env.get("DOCKER_PAT")
    if not token and not (username and pat):
        raise AuthError("set DOCKER_ACCESS_TOKEN, or DOCKER_USERNAME and DOCKER_PAT")
    sdk = _sdk()
    if token:
        return sdk.client.SyncSandboxesClient(access_token=token)
    return sdk.client.SyncSandboxesClient(auth=sdk.client.PATAuth(username=username, personal_access_token=pat))


@dataclass
class RunOutcome:
    exit_code: int
    stdout: str


class Backend:
    """Thin, synchronous adapter over a ``SyncSandboxesClient``."""

    def __init__(self, client, *, sdk=None, sleep=time.sleep):
        self._client = client
        self._sdk = sdk or _sdk()
        self._sleep = sleep

    def _retry(self, label: str, call, *, attempts: int = 5):
        """Sandbox-endpoint calls mint a scoped credential first; right after a sandbox comes up
        that minting answers ``resourceExhausted`` (seen live), so back off and try again."""
        for attempt in range(1, attempts + 1):
            try:
                return call()
            except self._sdk.client.RateLimitError:
                if attempt == attempts:
                    raise
                self._sleep(3.0 * attempt)
        raise AssertionError("unreachable")  # pragma: no cover

    def _options(self, request_id: str | None = None, **kw):
        if request_id:
            kw["idempotency_key"] = request_id
        return self._sdk.client.CallOptions(**kw)

    # --- resources --------------------------------------------------------
    def create_secret(self, *, display_name: str, service_type: str, token: str, request_id: str) -> str:
        secret = self._client.secrets.create(
            display_name=display_name, service_type=service_type,
            token=self._sdk.models.TokenSecretMaterial(value=token), options=self._options(request_id))
        return str(secret.resource.name)

    def list_secrets(self) -> list[tuple[str, str, str]]:
        """(name, service_type, display_name) of every stored secret in the account."""
        return [(str(s.name), str(s.service_type), str(s.display_name or ""))
                for s in self._client.secrets.all().collect()]

    def create_volume(self, *, display_name: str, request_id: str) -> str:
        volume = self._client.volumes.create(display_name=display_name, options=self._options(request_id))
        return str(volume.resource.name)

    def create_sandbox(self, *, display_name: str, kit_ref: str, artifact: bytes, resources: str,
                       volume: str | None, volume_target: str, secrets: list[str],
                       environment: dict[str, str], lifecycle: dict[str, Any] | None,
                       request_id: str) -> str:
        """Create from the inline v2 artifact (the shape ``kits.launch`` uses for the
        bundled catalog). The artifact's ``manifest.template`` names the image, so no
        ``image``/``image_ref`` is sent."""
        storage: dict[str, Any] = {}
        if volume:
            # Exclusive is what lets a volume-backed sandbox hibernate (seen live, 2026-10-22).
            storage["volumes"] = [self._sdk.models.VolumeAttachment(
                volume=volume, target=volume_target, mode=self._sdk.models.AttachmentMode("exclusive"))]
        if secrets:
            storage["secrets"] = list(secrets)
        kwargs: dict[str, Any] = {
            "display_name": display_name,
            "resources": self._resources(resources),
            "kits": [self._sdk.models.KitInput(artifact=self._sdk.models.KitArtifactInput(
                ref=self._sdk.models.KitRef(ref=kit_ref, kind=self._sdk.models.KitRefKind(SANDBOX_KIND)), inline=artifact))],
            "options": self._options(request_id, timeout=CREATE_TIMEOUT_SECONDS),
        }
        if storage:
            kwargs["storage"] = storage
        if environment:
            kwargs["environment"] = dict(environment)
        if lifecycle:
            kwargs["lifecycle"] = self._lifecycle_options(lifecycle)
        accepted = self._client.create(**kwargs)
        return str(accepted.name)

    def _resources(self, size: str):
        """``create`` takes a ``Resources`` model, not the catalog's size names."""
        if size not in COMPUTE_SIZES:
            raise ValueError(f"resources must be one of {sorted(COMPUTE_SIZES)}")
        cpus, memory_mib = COMPUTE_SIZES[size]
        return self._sdk.models.Resources(cpus=cpus, memory_mib=memory_mib)

    def _lifecycle_options(self, lifecycle: dict[str, Any]) -> dict[str, Any]:
        out = dict(lifecycle)
        if isinstance(out.get("on_timeout"), str):
            out["on_timeout"] = self._sdk.models.TimeoutAction(out["on_timeout"])
        return out

    def wait_running(self, name: str, *, timeout: float) -> None:
        handle = self._client.get(name)
        handle.wait_until_running(options=self._sdk.client.WaitOptions(timeout=timeout))

    def status(self, name: str) -> str:
        return str(self._client.get(name).resource.core.status)

    def start(self, name: str, *, timeout: float) -> None:
        """Resume a hibernated sandbox (a fresh handle: an older one's etag fails after any change)."""
        self._client.get(name).start(options=self._options(timeout=timeout))

    def publish_port(self, name: str, *, number: int, request_id: str) -> str:
        sandbox = self._client.get(name)
        for existing in sandbox.ports.list().items:
            if int(existing.resource.number) == number and existing.resource.url:
                return str(existing.resource.url)
        port = sandbox.ports.create(number=number, options=self._options(request_id))
        return str(port.resource.url)

    def read_file(self, name: str, path: str, *, max_bytes: int = 64 * 1024) -> bytes | None:
        try:
            return bytes(self._retry("files.read", lambda: self._client.get(name).files.read(path, max_bytes=max_bytes)))
        except self._sdk.client.NotFoundError:
            return None

    def run(self, name: str, args: list[str], *, timeout: float = 60) -> RunOutcome:
        result = self._retry("processes.run", lambda: self._client.get(name).processes.run(
            args=list(args), options=self._options(timeout=timeout)))
        return RunOutcome(exit_code=int(result.exit_code), stdout=str(result.stdout))

    def renew(self, name: str, *, lifetime: timedelta) -> None:
        """Reset the remaining lifetime to *lifetime* from now (renewal can only extend)."""
        self._client.get(name).renew_timeout(timeout=lifetime)

    def exists(self, name: str) -> bool:
        try:
            self._client.get(name)
            return True
        except self._sdk.client.NotFoundError:
            return False

    def delete_sandbox(self, name: str) -> None:
        self._client.get(name).delete(force=True)

    def delete_volume(self, name: str) -> None:
        self._client.volumes.get(name).delete()

    def delete_secret(self, name: str) -> None:
        self._client.secrets.get(name).delete()


TIMEOUT_ACTIONS = ("restart", "stop", "keep", "delete")
# Cloud refuses a longer cycle ("timeout duration is outside the supported range").
MAX_LIFETIME = timedelta(hours=24)
# The first create from a new image waits on a ~1.5 GB pull; 180s timed out live.
CREATE_TIMEOUT_SECONDS = 600.0


def lifecycle(*, lifetime: timedelta, on_timeout: str = "restart") -> dict[str, Any]:
    """Create-time lifecycle options (``features.timeouts`` on the wire).

    With the volume attached exclusively the sandbox hibernates in place (seen
    live, 2026-10-22): ``restart`` hibernates and resumes it at the end of each
    cycle, keeping processes, memory and the published URL; it needs the
    AlwaysOn and Hibernate entitlements. ``stop`` hibernates and stays asleep;
    it is paired with auto-resume so a request can wake it (``hermes-sbx up``
    also resumes it). ``delete`` still works: the volume outlives the sandbox
    and ``up`` recreates it there."""
    if on_timeout not in TIMEOUT_ACTIONS:
        raise ValueError(f"on_timeout must be one of {TIMEOUT_ACTIONS}")
    if not timedelta(0) < lifetime <= MAX_LIFETIME:
        raise ValueError(f"lifetime must be within (0, {MAX_LIFETIME}] (Cloud refuses longer)")
    options: dict[str, Any] = {"timeout": lifetime, "on_timeout": on_timeout}
    if on_timeout == "stop":
        options["auto_resume"] = True
    return options
