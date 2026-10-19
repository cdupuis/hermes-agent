"""The Python packer must produce what the reference Go implementation produces.

Goldens come from ``tools/kitpack-go`` (docker/sbx-kits-contrib ``spec``); regenerate
with ``tools/regenerate-goldens.sh`` after touching ``kit/spec.yaml``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from hermes_sbx import kitpack

HERE = Path(__file__).resolve().parent
KIT_DIR = HERE.parents[1] / "kit"


def _golden(name: str) -> dict:
    return json.loads((HERE / "golden" / f"{name}.json").read_text(encoding="utf-8"))


def test_hermes_serve_kit_matches_reference_packer():
    assert kitpack.pack_dir(KIT_DIR) == _golden("hermes-serve")


def test_claude_contrib_kit_matches_reference_packer():
    # A second, richer kit (volumes, oauth template, install + startup commands,
    # agent context) so the mapping is not tuned to our own spec only.
    spec = yaml.safe_load((HERE / "fixtures" / "claude-spec.yaml").read_text(encoding="utf-8"))
    assert kitpack.pack(spec) == _golden("claude")


def test_image_override_rewrites_template_only():
    packed = kitpack.pack_dir(KIT_DIR, image="example.test/hermes:pinned")
    expected = _golden("hermes-serve")
    expected["manifest"]["template"] = "example.test/hermes:pinned"
    assert packed == expected


def test_entrypoint_tail_prefixes_both_launch_modes():
    spec = {"schemaVersion": "2", "kind": "sandbox", "name": "k",
            "sandbox": {"image": "img", "entrypoint": ["tool", "--always"], "command": ["--batch"]}}
    manifest = kitpack.pack(spec)["manifest"]
    assert manifest["binary"] == "tool"
    assert manifest["runOptions"] == ["--always", "--batch"]
    assert manifest["interactiveOptions"] == ["--always", "--batch"]


def test_memory_is_reported_in_mib():
    spec = {"schemaVersion": "2", "kind": "sandbox", "name": "k",
            "sandbox": {"image": "img", "resources": {"cpu": 2, "memory": "4g"}}}
    assert kitpack.pack(spec)["manifest"]["resources"] == {"cpu": 2, "memoryMB": 4096}


def test_bearer_scheme_expands_to_authorization_header():
    spec = {"schemaVersion": "2", "kind": "mixin", "name": "m", "credentials": [
        {"service": "x", "apiKey": {"name": "X_TOKEN", "inject": [{"domain": "api.x", "scheme": "bearer"}]}}]}
    inject = kitpack.pack(spec)["credentials"][0]["apiKey"]["inject"][0]
    assert inject == {"domain": "api.x", "header": "Authorization", "format": "Bearer %s"}


@pytest.mark.parametrize("bad", [
    {"schemaVersion": "1", "kind": "mixin", "name": "m"},
    {"schemaVersion": "2", "kind": "mixin", "name": "m", "sandbox": {"image": "img"}},
    {"schemaVersion": "2", "kind": "sandbox", "name": "k"},
])
def test_invalid_specs_are_refused(bad):
    with pytest.raises(kitpack.KitPackError):
        kitpack.pack(bad)


def test_files_tree_is_refused(tmp_path):
    (tmp_path / "spec.yaml").write_text('schemaVersion: "2"\nkind: mixin\nname: m\n', encoding="utf-8")
    (tmp_path / "files" / "home").mkdir(parents=True)
    (tmp_path / "files" / "home" / "x").write_text("x", encoding="utf-8")
    with pytest.raises(kitpack.KitPackError, match="files/"):
        kitpack.load_spec(tmp_path)


def test_artifact_bytes_round_trip():
    artifact = kitpack.pack_dir(KIT_DIR)
    assert json.loads(kitpack.artifact_bytes(artifact)) == artifact
