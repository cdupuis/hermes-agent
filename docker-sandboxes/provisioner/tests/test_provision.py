from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_sbx.provision import LOGIN_FILE, ProvisionConfig, ProvisionError, Provisioner, desktop_connection
from hermes_sbx.sdk import RunOutcome
from hermes_sbx.state import BackendState, load_state, save_state

KIT_DIR = Path(__file__).resolve().parents[2] / "kit"
LOGIN = json.dumps({"username": "hermes", "password": "pw-123"}).encode()


class FakeBackend:
    """Records every call; the login file appears after ``login_after`` reads."""

    def __init__(self, *, login_after: int = 0):
        self.calls: list[tuple] = []
        self._reads = 0
        self._login_after = login_after
        self.status_value = "running"

    def create_secret(self, **kw):
        self.calls.append(("create_secret", kw))
        return "secrets/s1"

    account_secrets = [("secrets/acct-anthropic", "anthropic"), ("secrets/acct-docker", "docker")]

    def list_secrets(self):
        self.calls.append(("list_secrets",))
        return list(self.account_secrets)

    def create_volume(self, **kw):
        self.calls.append(("create_volume", kw))
        return "volumes/v1"

    def create_sandbox(self, **kw):
        self.calls.append(("create_sandbox", kw))
        return "sandboxes/sb1"

    def wait_running(self, name, *, timeout):
        self.calls.append(("wait_running", name, timeout))

    def publish_port(self, name, *, number, request_id):
        self.calls.append(("publish_port", name, number, request_id))
        return "https://sb1-9119.sandboxes.example"

    def read_file(self, name, path, **kw):
        self.calls.append(("read_file", name, path))
        self._reads += 1
        return LOGIN if self._reads > self._login_after else None

    def run(self, name, args, **kw):
        self.calls.append(("run", name, list(args)))
        return RunOutcome(exit_code=0, stdout="")

    def delete_sandbox(self, name):
        self.calls.append(("delete_sandbox", name))

    def delete_volume(self, name):
        self.calls.append(("delete_volume", name))

    def delete_secret(self, name):
        self.calls.append(("delete_secret", name))

    def status(self, name):
        return self.status_value

    gone: set = set()

    def exists(self, name):
        self.calls.append(("exists", name))
        return name not in self.gone

    def names(self):
        return [c[0] for c in self.calls]


def _prov(backend):
    return Provisioner(backend, log=lambda _m: None, sleep=lambda _s: None, clock=lambda: 0.0)


def _cfg(**overrides):
    base = dict(name="demo", kit_dir=KIT_DIR, anthropic_api_key="sk-ant-test", resources="small")
    base.update(overrides)
    return ProvisionConfig(**base)


def test_up_creates_everything_in_order_and_reads_the_login_once():
    backend = FakeBackend()
    state = _prov(backend).up(_cfg())

    assert backend.names() == ["create_secret", "create_volume", "create_sandbox", "wait_running",
                               "publish_port", "read_file", "run"]
    secret = backend.calls[0][1]
    assert secret["service_type"] == "anthropic" and secret["token"] == "sk-ant-test"
    sandbox = backend.calls[2][1]
    assert sandbox["display_name"] == "demo"
    assert sandbox["kit_ref"] == "hermes-serve"
    assert sandbox["volume"] == "volumes/v1" and sandbox["volume_target"] == "/home/agent/.hermes"
    assert sandbox["secrets"] == ["secrets/s1"]
    assert json.loads(sandbox["artifact"])["manifest"]["binary"] == "/usr/local/bin/hermes-start"
    assert backend.calls[6] == ("run", "sandboxes/sb1", ["rm", "-f", LOGIN_FILE])
    assert state == BackendState(name="demo", sandbox="sandboxes/sb1", volume="volumes/v1", secret="secrets/s1",
                                 url="https://sb1-9119.sandboxes.example", username="hermes", password="pw-123")


def test_request_ids_are_stable_per_name_and_step():
    backend = FakeBackend()
    _prov(backend).up(_cfg())
    ids = [kw["request_id"] for call, kw in backend.calls[:3]]
    assert ids[:2] == ["hermes-sbx:demo:secret", "hermes-sbx:demo:volume"]
    assert ids[2].startswith("hermes-sbx:demo:sandbox:")


def test_sandbox_request_id_replays_same_request_and_changes_with_it():
    def sandbox_id(**cfg):
        backend = FakeBackend()
        # Same pending nonce = the same request retried; a changed config is a new request.
        _prov(backend).up(_cfg(**cfg), BackendState(name="demo", extra={"login_nonce": "n1"}))
        return next(kw["request_id"] for call, kw in backend.calls if call == "create_sandbox")
    assert sandbox_id() == sandbox_id()
    assert sandbox_id() != sandbox_id(resources="medium")
    assert sandbox_id() != sandbox_id(image="example.test/other:tag")


def test_up_resumes_from_state_without_recreating():
    backend = FakeBackend()
    partial = BackendState(name="demo", secret="secrets/old", volume="volumes/old", sandbox="sandboxes/old")
    state = _prov(backend).up(_cfg(), partial)
    assert backend.names() == ["exists", "wait_running", "publish_port", "read_file", "run"]
    assert state.sandbox == "sandboxes/old" and state.volume == "volumes/old"


def test_up_with_complete_state_only_reverifies():
    backend = FakeBackend()
    done = BackendState(name="demo", secret="s", volume="v", sandbox="sb", url="https://u",
                        username="hermes", password="pw")
    state = _prov(backend).up(_cfg(), done)
    assert backend.names() == ["exists", "wait_running"]
    assert state == done


def test_existing_secret_is_attached_instead_of_stored():
    backend = FakeBackend()
    _prov(backend).up(_cfg(anthropic_api_key=None, secret_name="secrets/mine"))
    assert "create_secret" not in backend.names()
    assert backend.calls[1][1]["secrets"] == ["secrets/mine"]




def test_image_override_reaches_the_artifact():
    backend = FakeBackend()
    _prov(backend).up(_cfg(image="example.test/hermes:dev"))
    artifact = json.loads(backend.calls[2][1]["artifact"])
    assert artifact["manifest"]["template"] == "example.test/hermes:dev"


def test_login_readout_waits_for_the_bootstrap():
    backend = FakeBackend(login_after=3)
    state = _prov(backend).up(_cfg())
    assert backend.names().count("read_file") == 4
    assert state.password == "pw-123"


def test_login_readout_times_out_with_a_pointer_to_the_logs():
    backend = FakeBackend(login_after=10**6)
    ticks = iter(range(0, 10**6, 10))
    prov = Provisioner(backend, log=lambda _m: None, sleep=lambda _s: None, clock=lambda: next(ticks))
    with pytest.raises(ProvisionError, match="sbx exec"):
        prov.up(_cfg(login_timeout=30))


def test_down_keeps_volume_and_secret_by_default():
    backend = FakeBackend()
    state = BackendState(name="demo", sandbox="sb", volume="v", secret="s")
    _prov(backend).down(state)
    assert backend.names() == ["delete_sandbox"]
    _prov(backend).down(state, delete_volume=True, delete_secret=True)
    assert backend.names()[1:] == ["delete_sandbox", "delete_volume", "delete_secret"]


def test_desktop_connection_is_a_remote_gateway_sign_in():
    state = BackendState(name="demo", url="https://u", username="hermes", password="pw")
    assert desktop_connection(state) == {"url": "https://u", "auth": "Sign in (username/password)",
                                         "username": "hermes", "password": "pw"}


def test_state_round_trips_and_is_private(tmp_path):
    state = BackendState(name="demo", sandbox="sb", password="pw")
    path = save_state(tmp_path, state)
    assert load_state(tmp_path, "demo") == state
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert load_state(tmp_path, "other") is None


def test_up_records_progress_in_the_passed_state_even_when_it_fails():
    class Failing(FakeBackend):
        def create_sandbox(self, **kw):
            raise RuntimeError("refused")
    state = BackendState(name="demo")
    with pytest.raises(RuntimeError):
        _prov(Failing()).up(_cfg(), state)
    assert state.volume == "volumes/v1" and state.secret == "secrets/s1" and not state.sandbox


def test_expired_sandbox_is_recreated_on_the_same_volume():
    backend = FakeBackend()
    backend.gone = {"sandboxes/expired"}
    state = BackendState(name="demo", secret="s", volume="volumes/keep", sandbox="sandboxes/expired",
                         url="https://old", username="hermes", password="pw")
    _prov(backend).up(_cfg(), state)
    created = next(kw for call, kw in backend.calls if call == "create_sandbox")
    assert created["volume"] == "volumes/keep"
    assert created["secrets"] == ["s"]  # the recreated sandbox gets its credential too
    assert state.sandbox == "sandboxes/sb1" and state.url == "https://sb1-9119.sandboxes.example"
    assert state.password == "pw-123"  # the new sandbox issued a fresh login
    assert created["environment"]["HSBX_LOGIN_NONCE"]


def test_each_new_sandbox_carries_a_login_nonce_that_a_retry_reuses():
    class FailOnce(FakeBackend):
        failed = False

        def create_sandbox(self, **kw):
            if not FailOnce.failed:
                FailOnce.failed = True
                self.calls.append(("create_sandbox", kw))
                raise RuntimeError("transient")
            return super().create_sandbox(**kw)
    backend = FailOnce()
    state = BackendState(name="demo")
    with pytest.raises(RuntimeError):
        _prov(backend).up(_cfg(), state)
    _prov(backend).up(_cfg(), state)
    nonces = {c[1]["environment"]["HSBX_LOGIN_NONCE"] for c in backend.calls if c[0] == "create_sandbox"}
    assert len(nonces) == 1
    assert "login_nonce" not in state.extra  # consumed once the login was read


def test_without_an_explicit_secret_the_accounts_own_is_attached():
    backend = FakeBackend()
    _prov(backend).up(_cfg(anthropic_api_key=None))
    created = next(c[1] for c in backend.calls if c[0] == "create_sandbox")
    assert created["secrets"] == ["secrets/acct-anthropic"]


def test_an_account_without_a_model_secret_is_refused_before_the_sandbox():
    backend = FakeBackend()
    backend.account_secrets = [("secrets/acct-docker", "docker")]
    with pytest.raises(ProvisionError, match="no stored anthropic"):
        _prov(backend).up(_cfg(anthropic_api_key=None))
    assert not any(c[0] in ("create_volume", "create_sandbox") for c in backend.calls)
