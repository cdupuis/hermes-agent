"""Pack a v2 kit ``spec.yaml`` into the artifact JSON the Sandboxes API takes inline.

Mirrors ``specFileV2.toArtifact`` in docker/sbx-kits-contrib ``spec/v2.go`` for the
field set this kit uses. ``tools/kitpack-go`` runs the reference implementation; the
goldens under ``tests/golden`` pin the two together.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

_SIZE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?)(?:i?b)?\s*$", re.IGNORECASE)
_SIZE_UNITS = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4, "p": 1024**5}


class KitPackError(ValueError):
    pass


def ram_in_bytes(size: str) -> int:
    """``go-units.RAMInBytes``: binary suffixes, optional ``b``/``ib``."""
    match = _SIZE_RE.match(size)
    if not match:
        raise KitPackError(f"invalid size {size!r}")
    number, unit = match.groups()
    return int(float(number) * _SIZE_UNITS[unit.lower()])


def _strip(value: Any) -> Any:
    """Drop what Go's ``omitempty`` drops: zero values, nil, empty containers."""
    if isinstance(value, dict):
        out = {k: _strip(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v not in (None, "", [], {}, False, 0)}
    if isinstance(value, list):
        return [_strip(v) for v in value]
    return value


def _expand_credential_schemes(creds: list[dict]) -> list[dict]:
    out = []
    for i, cred in enumerate(creds):
        cred = dict(cred)
        api_key = cred.get("apiKey")
        if api_key:
            api_key = dict(api_key)
            injects = []
            for j, inj in enumerate(api_key.get("inject") or []):
                inj = dict(inj)
                scheme = inj.pop("scheme", "")
                if scheme:
                    where = f"credentials[{i}].apiKey.inject[{j}]"
                    if inj.get("format"):
                        raise KitPackError(f"{where}: 'scheme' and 'format' are mutually exclusive")
                    if scheme == "bearer":
                        if inj.get("username"):
                            raise KitPackError(f"{where}: 'username' is not valid with scheme: bearer")
                        inj["format"] = "Bearer %s"
                        inj.setdefault("header", "Authorization")
                    elif scheme == "basic":
                        if not inj.get("username"):
                            raise KitPackError(f"{where}: scheme: basic requires 'username'")
                        inj["format"] = "%s"
                    else:
                        raise KitPackError(f'{where}: unknown scheme {scheme!r} (want "basic" or "bearer")')
                injects.append(inj)
            api_key["inject"] = injects
            cred["apiKey"] = api_key
        out.append(cred)
    return out


def pack(spec: dict, *, image: str | None = None) -> dict:
    """Return the artifact (``spec.Artifact`` JSON shape) for a decoded v2 spec."""
    if str(spec.get("schemaVersion")) != "2":
        raise KitPackError("only schemaVersion \"2\" kits are supported")
    kind = spec.get("kind", "")
    sandbox = spec.get("sandbox")
    if sandbox is not None and kind != "sandbox":
        raise KitPackError(f"'sandbox:' block is only valid for kind \"sandbox\", not {kind!r}")
    if sandbox is None and kind == "sandbox" and not spec.get("extends"):
        raise KitPackError("kind \"sandbox\" requires a 'sandbox:' block with at least 'sandbox.image'")

    manifest: dict[str, Any] = {
        "schemaVersion": "2",
        "kind": kind,
        "name": spec.get("name", ""),
        "version": spec.get("version"),
        "displayName": spec.get("displayName"),
        "description": spec.get("description"),
        "sourceURL": spec.get("sourceURL"),
        "security": spec.get("security"),
        "volumes": spec.get("volumes"),
    }
    if sandbox is not None:
        manifest["template"] = image or sandbox.get("image")
        if sandbox.get("build"):
            if not sandbox.get("image"):
                raise KitPackError("sandbox.build is accepted in the schema but not yet implemented — specify sandbox.image")
            manifest["build"] = sandbox["build"]
        entrypoint = list(sandbox.get("entrypoint") or [])
        tail = entrypoint[1:]
        if entrypoint:
            manifest["binary"] = entrypoint[0]
        command = sandbox.get("command")
        if isinstance(command, list):
            default, interactive = command, None
        elif isinstance(command, dict):
            default, interactive = command.get("default"), command.get("interactive")
        elif command is None:
            default, interactive = None, None
        else:
            raise KitPackError("sandbox.command: must be a list (shorthand) or a mapping with default/interactive")
        if interactive is None:
            interactive = default
        manifest["runOptions"] = tail + list(default or [])
        manifest["interactiveOptions"] = tail + list(interactive or [])
        resources = sandbox.get("resources")
        if resources:
            res = {"cpu": resources.get("cpu"), "gpu": resources.get("gpu")}
            if resources.get("memory"):
                res["memoryMB"] = ram_in_bytes(str(resources["memory"])) // (1024 * 1024)
            manifest["resources"] = res
    instructions = spec.get("agentInstructions") or {}
    if kind == "sandbox" and instructions.get("filename"):
        manifest["aiFilename"] = instructions["filename"]

    artifact: dict[str, Any] = {
        "manifest": manifest,
        "extends": spec.get("extends"),
        "mixins": spec.get("mixins"),
        "requires": spec.get("requires"),
        "locked": spec.get("locked"),
        "licenses": spec.get("licenses"),
        "args": spec.get("args"),
        "publishedPorts": spec.get("ports"),
        "environment": {"variables": (spec.get("environment") or {}).get("variables")},
        "agentContext": instructions.get("content"),
    }
    network = (spec.get("permissions") or {}).get("network") or {}
    if network.get("allow") or network.get("deny"):
        artifact["caps"] = {"network": {"allow": network.get("allow"), "deny": network.get("deny")}}
    setup = spec.get("setup")
    if setup is not None:
        artifact["commands"] = {
            "install": setup.get("install"),
            "startup": setup.get("startup"),
            "initFiles": setup.get("files"),
        }
    artifact["credentials"] = _expand_credential_schemes(spec.get("credentials") or [])

    out = _strip(artifact)
    # Required fields Go always emits, zero or not.
    out["manifest"] = {"schemaVersion": "2", "kind": kind, "name": spec.get("name", ""), **out.get("manifest", {})}
    return out


def load_spec(kit_dir: Path) -> dict:
    spec_path = Path(kit_dir) / "spec.yaml"
    if not spec_path.is_file():
        raise KitPackError(f"no spec.yaml under {kit_dir}")
    files_dir = Path(kit_dir) / "files"
    if files_dir.is_dir() and any(files_dir.rglob("*")):
        raise KitPackError("kits with a files/ tree are not supported by this packer; bake files into the image")
    with spec_path.open(encoding="utf-8") as fh:
        spec = yaml.safe_load(fh)
    if not isinstance(spec, dict):
        raise KitPackError(f"{spec_path} is not a mapping")
    return spec


def pack_dir(kit_dir: Path, *, image: str | None = None) -> dict:
    return pack(load_spec(kit_dir), image=image)


def artifact_bytes(artifact: dict) -> bytes:
    return json.dumps(artifact, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
