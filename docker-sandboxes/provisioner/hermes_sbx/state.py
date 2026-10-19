"""Per-backend state file: the resource names a provisioning run created or adopted."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class BackendState:
    name: str
    sandbox: str = ""
    volume: str = ""
    secret: str = ""
    url: str = ""
    username: str = ""
    password: str = ""
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> BackendState:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


def default_state_dir() -> Path:
    return Path.home() / ".hermes-sbx"


def state_path(state_dir: Path, name: str) -> Path:
    return Path(state_dir) / f"{name}.json"


def load_state(state_dir: Path, name: str) -> BackendState | None:
    path = state_path(state_dir, name)
    if not path.is_file():
        return None
    return BackendState.from_dict(json.loads(path.read_text(encoding="utf-8")))


def save_state(state_dir: Path, state: BackendState) -> Path:
    path = state_path(state_dir, state.name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(asdict(state), indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)  # the file carries the backend login
    os.replace(tmp, path)
    return path


def delete_state(state_dir: Path, name: str) -> None:
    try:
        state_path(state_dir, name).unlink()
    except FileNotFoundError:
        pass
