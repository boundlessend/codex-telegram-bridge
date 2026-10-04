from __future__ import annotations

from collections.abc import Mapping
import json
import os
from pathlib import Path
import subprocess
from typing import cast
from uuid import uuid4


SERVICE = "codex-telegram-bridge"
BOT_ROOT = Path(__file__).resolve().parent.parent
STATE_ROOT = Path.home() / "Library/Application Support/CodexTelegramBridge"


class RuntimeConfigurationError(RuntimeError):
    pass


def read_settings() -> dict[str, str]:
    value: object = json.loads((STATE_ROOT / "settings.json").read_text())
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        raise RuntimeConfigurationError("settings.json must contain string environment settings")
    return cast(dict[str, str], value)


def read_credential() -> str:
    result = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-w"], capture_output=True, text=True, timeout=10)
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeConfigurationError("Telegram credential is unavailable in Keychain: exit_code=" + str(result.returncode))
    return result.stdout.strip()


def build_environment(settings: Mapping[str, str], token: str) -> dict[str, str]:
    environment: dict[str, str] = {name: value for name, value in os.environ.items()
                                 if name in {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"} or name.startswith("LC_")}
    environment.update(settings)
    agent = subprocess.run(["launchctl", "getenv", "SSH_AUTH_SOCK"], capture_output=True, text=True, timeout=10)
    if agent.returncode != 0:
        raise RuntimeConfigurationError("launchctl getenv failed: exit_code=" + str(agent.returncode))
    if agent.stdout.strip():
        environment["SSH_AUTH_SOCK"] = agent.stdout.strip()
    environment["CODEX_ENV_JSON"] = json.dumps({name: value for name, value in environment.items()
                                               if name in {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "SSH_AUTH_SOCK"} or name.startswith("LC_")})
    environment["TELEGRAM_BOT_TOKEN"] = token
    return environment


def load_environment() -> dict[str, str]:
    return build_environment(read_settings(), read_credential())


def atomic_write(file: Path, data: bytes) -> None:
    temporary = file.with_name(file.name + "." + str(uuid4()) + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def start_entrypoint(entrypoint: Path) -> None:
    os.umask(0o077)
    environment = load_environment()
    os.chdir(BOT_ROOT)
    node = environment["CODEX_TELEGRAM_NODE"]
    os.execve(node, [node, str(entrypoint)], environment)
