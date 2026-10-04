from __future__ import annotations

from collections.abc import Mapping
import json
import getpass
import os
from pathlib import Path
import stat
import subprocess
import sys
from typing import cast
from uuid import uuid4


SERVICE = "codex-telegram-bridge"
BOT_ROOT = Path(__file__).resolve().parent.parent


class RuntimeConfigurationError(RuntimeError):
    pass


def runtime_directory(platform: str, home: Path, environment: Mapping[str, str]) -> Path:
    override = environment.get("CODEX_TELEGRAM_RUNTIME_DIR")
    if override:
        root = Path(override)
    elif platform == "darwin":
        root = home / "Library/Application Support/CodexTelegramBridge"
    elif platform == "linux":
        root = Path(environment.get("XDG_STATE_HOME", str(home / ".local/state"))) / SERVICE
    else:
        raise RuntimeConfigurationError("The bridge supports macOS and Linux")
    if not root.is_absolute():
        raise RuntimeConfigurationError("The runtime directory must be an absolute path")
    return root


STATE_ROOT = runtime_directory(sys.platform, Path.home(), os.environ)


def ensure_private_directory(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeConfigurationError("Runtime directory must be owned by the current user and not be a symlink")
    directory.chmod(0o700)


def string_settings(data: bytes) -> dict[str, str]:
    value: object = json.loads(data)
    if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        raise RuntimeConfigurationError("settings.json must contain string environment settings")
    return cast(dict[str, str], value)


def read_settings() -> dict[str, str]:
    return string_settings((STATE_ROOT / "settings.json").read_bytes())


def saved_credential() -> str | None:
    if sys.platform == "darwin":
        result = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-w"], capture_output=True, text=True, timeout=10)
        if result.returncode == 44:
            return None
        if result.returncode != 0 or not result.stdout.strip():
            raise RuntimeConfigurationError("Telegram credential is unavailable in Keychain: exit_code=" + str(result.returncode))
        return result.stdout.strip()
    file = STATE_ROOT / "telegram.token"
    if not file.exists():
        return None
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeConfigurationError("Telegram credential must be a regular owner-only file with mode 600")
    token = file.read_text().strip()
    if not token:
        raise RuntimeConfigurationError("Telegram credential is empty")
    return token


def read_credential() -> str:
    value = saved_credential()
    if value is None:
        raise RuntimeConfigurationError("Run bridge setup to store the Telegram credential")
    return value


def write_credential(token: str) -> None:
    if sys.platform == "darwin":
        result = subprocess.run(["security", "add-generic-password", "-U", "-a", getpass.getuser(), "-s", SERVICE, "-w", token], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            raise RuntimeConfigurationError("Keychain credential storage failed: exit_code=" + str(result.returncode))
    else:
        atomic_write(STATE_ROOT / "telegram.token", (token + "\n").encode())


def remove_credential() -> None:
    if sys.platform == "darwin":
        result = subprocess.run(["security", "delete-generic-password", "-s", SERVICE], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            raise RuntimeConfigurationError("Keychain credential rollback failed: exit_code=" + str(result.returncode))
    else:
        (STATE_ROOT / "telegram.token").unlink()


def build_environment(settings: Mapping[str, str], token: str) -> dict[str, str]:
    names = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "SSH_AUTH_SOCK", "CODEX_HOME",
             "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"}
    environment: dict[str, str] = {name: value for name, value in os.environ.items() if name in names or name.startswith("LC_")}
    environment.update(settings)
    node = settings["CODEX_TELEGRAM_NODE"]
    environment["PATH"] = str(Path(node).parent) + os.pathsep + environment.get("PATH", os.defpath)
    if sys.platform == "darwin":
        agent = subprocess.run(["launchctl", "getenv", "SSH_AUTH_SOCK"], capture_output=True, text=True, timeout=10)
        if agent.returncode != 0:
            raise RuntimeConfigurationError("launchctl getenv failed: exit_code=" + str(agent.returncode))
        if agent.stdout.strip():
            environment["SSH_AUTH_SOCK"] = agent.stdout.strip()
    if "CODEX_ENV_JSON" not in settings:
        environment["CODEX_ENV_JSON"] = json.dumps({name: value for name, value in environment.items() if name in names or name.startswith("LC_")})
    environment["TELEGRAM_BOT_TOKEN"] = token
    environment["CODEX_TELEGRAM_RUNTIME_DIR"] = str(STATE_ROOT)
    return environment


def load_environment() -> dict[str, str]:
    return build_environment(read_settings(), read_credential())


def installed_root(settings: Mapping[str, str]) -> Path:
    value = settings.get("CODEX_TELEGRAM_APP_ROOT")
    if not value:
        raise RuntimeConfigurationError("Run bridge setup to migrate this installation to a permanent runtime")
    root = Path(value)
    if not root.is_absolute() or not (root / "package.json").is_file():
        raise RuntimeConfigurationError("Installed runtime is unavailable; rerun bridge setup")
    return root


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
    settings = read_settings()
    environment = build_environment(settings, read_credential())
    root = installed_root(settings)
    os.chdir(root)
    node = environment["CODEX_TELEGRAM_NODE"]
    os.execve(node, [node, str(root / "src" / entrypoint.name)], environment)
