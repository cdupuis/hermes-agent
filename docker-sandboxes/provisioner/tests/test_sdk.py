"""Pin the request shapes the adapter hands to ``docker_sandboxes_api``.

A stub namespace stands in for the SDK's ``models`` / ``sandboxes_client`` modules so
these run without the package; the shapes follow its ``SyncSandboxesClient`` signatures
and ``kits.launch`` (inline artifact), ``storage.volumes/secrets``, ``ports.create``.
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest

from hermes_sbx import sdk


class _Record:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def __eq__(self, other):
        return type(self) is type(other) and self.__dict__ == other.__dict__

    def __repr__(self):
        return f"{type(self).__name__}({self.__dict__})"


class CallOptions(_Record):
    pass


class WaitOptions(_Record):
    pass


class TokenSecretMaterial(_Record):
    pass


class VolumeAttachment(_Record):
    pass


class KitInput(_Record):
    pass


class KitArtifactInput(_Record):
    pass


class KitRef(_Record):
    pass


class Resources(_Record):
    pass


class _Enum(str):
    pass


class KitRefKind(_Enum):
    pass


class TimeoutAction(_Enum):
    pass


class AttachmentMode(_Enum):
    pass


class NotFoundError(Exception):
    pass


class RateLimitError(Exception):
    pass


STUB_SDK = SimpleNamespace(
    models=SimpleNamespace(TokenSecretMaterial=TokenSecretMaterial, VolumeAttachment=VolumeAttachment,
                           KitInput=KitInput, KitArtifactInput=KitArtifactInput, KitRef=KitRef,
                           KitRefKind=KitRefKind, TimeoutAction=TimeoutAction, Resources=Resources,
                           AttachmentMode=AttachmentMode),
    client=SimpleNamespace(CallOptions=CallOptions, WaitOptions=WaitOptions, NotFoundError=NotFoundError,
                           RateLimitError=RateLimitError),
)


class FakeClient:
    def __init__(self):
        self.calls = []
        self.secrets = SimpleNamespace(
            create=self._rec("secrets.create", SimpleNamespace(resource=SimpleNamespace(name="secrets/abc"))),
            get=lambda name: SimpleNamespace(delete=self._rec(f"secrets.delete:{name}", None)))
        self.volumes = SimpleNamespace(
            create=self._rec("volumes.create", SimpleNamespace(resource=SimpleNamespace(name="volumes/abc"))),
            get=lambda name: SimpleNamespace(delete=self._rec(f"volumes.delete:{name}", None)))
        self.ports = []
        self.files_content = b'{"username":"hermes","password":"pw"}'

    def _rec(self, label, result):
        def call(**kw):
            self.calls.append((label, kw))
            return result
        return call

    def create(self, **kw):
        self.calls.append(("create", kw))
        return SimpleNamespace(name="sandboxes/abc")

    def get(self, name):
        self.calls.append(("get", name))
        client = self

        class Sandbox:
            resource = SimpleNamespace(core=SimpleNamespace(status="running"))
            ports = SimpleNamespace(
                list=lambda: SimpleNamespace(items=list(client.ports)),
                create=client._rec("ports.create", SimpleNamespace(resource=SimpleNamespace(
                    number=9119, url="https://abc.example"))))
            files = SimpleNamespace(read=lambda path, **kw: client._read(path, **kw))
            processes = SimpleNamespace(run=client._rec("processes.run", SimpleNamespace(exit_code=0, stdout="ok")))

            def wait_until_running(self, **kw):
                client.calls.append(("wait_until_running", kw))

            def delete(self, **kw):
                client.calls.append(("delete", kw))
        return Sandbox()

    def _read(self, path, **kw):
        self.calls.append(("files.read", path, kw))
        if self.files_content is None:
            raise NotFoundError(path)
        return self.files_content


def _backend():
    client = FakeClient()
    return client, sdk.Backend(client, sdk=STUB_SDK, sleep=lambda _s: None)


def test_endpoint_calls_retry_after_rate_limit():
    client, backend = _backend()
    failures = {"n": 2}

    def flaky(path, **kw):
        if failures["n"]:
            failures["n"] -= 1
            raise RateLimitError("resourceExhausted")
        return b"late"
    client._read = lambda path, **kw: flaky(path, **kw)
    assert backend.read_file("sandboxes/abc", "/x") == b"late"


def test_rate_limit_gives_up_after_attempts():
    client, backend = _backend()
    client._read = lambda path, **kw: (_ for _ in ()).throw(RateLimitError("resourceExhausted"))
    with pytest.raises(RateLimitError):
        backend.read_file("sandboxes/abc", "/x")


def test_create_sandbox_sends_the_inline_artifact_the_way_kits_launch_does():
    client, backend = _backend()
    name = backend.create_sandbox(
        display_name="demo", kit_ref="hermes-serve", artifact=b'{"manifest":{}}', resources="small",
        volume="volumes/v", volume_target="/home/agent/.hermes", secrets=["secrets/s"],
        environment={"X": "1"}, lifecycle={"timeout": timedelta(days=1), "on_timeout": "delete"},
        request_id="req-1")
    assert name == "sandboxes/abc"
    label, kw = client.calls[0]
    assert label == "create"
    assert kw == {
        "display_name": "demo",
        "resources": Resources(cpus=2, memory_mib=4096),
        "kits": [KitInput(artifact=KitArtifactInput(ref=KitRef(ref="hermes-serve", kind=KitRefKind("sandbox")),
                                                     inline=b'{"manifest":{}}'))],
        "storage": {"volumes": [VolumeAttachment(volume="volumes/v", target="/home/agent/.hermes",
                                                  mode=AttachmentMode("exclusive"))],
                    "secrets": ["secrets/s"]},
        "environment": {"X": "1"},
        "lifecycle": {"timeout": timedelta(days=1), "on_timeout": TimeoutAction("delete")},
        "options": CallOptions(timeout=sdk.CREATE_TIMEOUT_SECONDS, idempotency_key="req-1"),
    }
    assert isinstance(kw["lifecycle"]["on_timeout"], TimeoutAction)
    assert "image" not in kw and "image_ref" not in kw


def test_create_sandbox_omits_empty_storage_and_lifecycle():
    client, backend = _backend()
    backend.create_sandbox(display_name="d", kit_ref="k", artifact=b"{}", resources="micro", volume=None,
                           volume_target="/x", secrets=[], environment={}, lifecycle=None, request_id="r")
    kw = client.calls[0][1]
    assert set(kw) == {"display_name", "resources", "kits", "options"}


def test_secret_and_volume_creation_carry_idempotency_keys():
    client, backend = _backend()
    assert backend.create_secret(display_name="k", service_type="anthropic", token="t", request_id="s1") == "secrets/abc"
    assert backend.create_volume(display_name="v", request_id="v1") == "volumes/abc"
    assert client.calls == [
        ("secrets.create", {"display_name": "k", "service_type": "anthropic",
                            "token": TokenSecretMaterial(value="t"), "options": CallOptions(idempotency_key="s1")}),
        ("volumes.create", {"display_name": "v", "options": CallOptions(idempotency_key="v1")}),
    ]


def test_publish_port_reuses_an_existing_publication():
    client, backend = _backend()
    client.ports = [SimpleNamespace(resource=SimpleNamespace(number=9119, url="https://already.example"))]
    assert backend.publish_port("sandboxes/abc", number=9119, request_id="p") == "https://already.example"
    assert not any(label == "ports.create" for label, *_ in client.calls)


def test_publish_port_creates_when_absent():
    client, backend = _backend()
    assert backend.publish_port("sandboxes/abc", number=9119, request_id="p") == "https://abc.example"
    assert ("ports.create", {"number": 9119, "options": CallOptions(idempotency_key="p")}) in client.calls


def test_read_file_returns_none_when_absent():
    client, backend = _backend()
    assert backend.read_file("sandboxes/abc", "/x") == b'{"username":"hermes","password":"pw"}'
    client.files_content = None
    assert backend.read_file("sandboxes/abc", "/x") is None


def test_run_wait_and_delete_shapes():
    client, backend = _backend()
    outcome = backend.run("sandboxes/abc", ["rm", "-f", "/x"])
    assert (outcome.exit_code, outcome.stdout) == (0, "ok")
    backend.delete_sandbox("sandboxes/abc")
    assert ("delete", {"force": True}) in client.calls
    backend.wait_running("sandboxes/abc", timeout=12.5)
    assert ("wait_until_running", {"options": WaitOptions(timeout=12.5)}) in client.calls
    backend.delete_volume("volumes/v")
    backend.delete_secret("secrets/s")
    assert ("volumes.delete:volumes/v", {}) in client.calls and ("secrets.delete:secrets/s", {}) in client.calls


def test_unknown_compute_size_is_refused():
    _, backend = _backend()
    with pytest.raises(ValueError, match="resources"):
        backend.create_sandbox(display_name="d", kit_ref="k", artifact=b"{}", resources="huge", volume=None,
                               volume_target="/x", secrets=[], environment={}, lifecycle=None, request_id="r")


def test_make_client_requires_credentials():
    with pytest.raises(sdk.AuthError):
        sdk.make_client({})
