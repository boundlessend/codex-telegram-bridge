from __future__ import annotations

import getpass
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
from typing import cast
import urllib.error
import urllib.request

from runtime import BOT_ROOT, SERVICE, STATE_ROOT, atomic_write, build_environment


ROOT = Path(__file__).resolve().parent


class SetupError(RuntimeError):
    pass


def validate_token(token: str) -> None:
    for attempt in range(3):
        try:
            with urllib.request.urlopen("https://api.telegram.org/bot" + token + "/getMe", timeout=15) as response:
                value: object = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise SetupError("Telegram rejected the token: HTTP " + str(error.code)) from None
        except urllib.error.URLError:
            if attempt == 2:
                raise SetupError("Telegram is unreachable after three attempts") from None
            print("Telegram недоступен, повторяю проверку токена")
            continue
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise SetupError("Telegram did not confirm the bot token")
        return


def install_service(label: str, entrypoint: Path) -> None:
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(exist_ok=True)
    logs = STATE_ROOT / "logs"
    logs.mkdir(mode=0o700, exist_ok=True)
    for suffix in ["stdout", "stderr"]:
        log = logs / (label + "." + suffix + ".log")
        log.touch(mode=0o600, exist_ok=True)
        log.chmod(0o600)
    contents: dict[str, object] = {
        "Label": label,
        "ProgramArguments": [sys.executable, str(entrypoint)],
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {"PATH": os.environ["PATH"], "HOME": str(Path.home())},
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "StandardOutPath": str(logs / (label + ".stdout.log")),
        "StandardErrorPath": str(logs / (label + ".stderr.log")),
    }
    target = agents / (label + ".plist")
    atomic_write(target, plistlib.dumps(contents))
    target.chmod(0o600)
    domain = "gui/" + str(os.getuid())
    status = subprocess.run(["launchctl", "print", domain + "/" + label], capture_output=True, text=True)
    if status.returncode == 0:
        subprocess.run(["launchctl", "bootout", domain + "/" + label], check=True, timeout=15)
        subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True, timeout=15)
    elif "Could not find service" in status.stderr:
        subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
    else:
        raise SetupError("LaunchAgent lookup failed: " + status.stderr.strip())


def main() -> None:
    parser = argparse.ArgumentParser(description="Configure the macOS Telegram bridge using Keychain")
    parser.add_argument("--workdir", required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SetupError("Keychain setup requires macOS; use the dotenv instructions on Linux")
    workdir: Path = args.workdir.expanduser().resolve(strict=True)
    if not workdir.is_dir():
        raise SetupError("The working directory must be an existing project directory")
    os.umask(0o077)
    print("Enter the Telegram bot token locally. Input is hidden; never paste it into chat")
    token = getpass.getpass("Telegram bot token: ").strip()
    if re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token) is None:
        raise SetupError("The token format is invalid")
    user_id = input("Allowed Telegram user ID (positive integer): ").strip()
    if not user_id.isascii() or not user_id.isdecimal() or int(user_id) <= 0:
        raise SetupError("Telegram user ID must be a positive integer")
    node = shutil.which("node")
    codex = shutil.which("codex")
    if node is None or codex is None:
        raise SetupError("node and codex must be available in PATH")
    validate_token(token)
    STATE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE_ROOT.chmod(0o700)
    settings: dict[str, str] = {
        "ALLOWED_USER_IDS": user_id,
        "ALLOWED_CHAT_IDS": user_id,
        "CODEX_TELEGRAM_NODE": node,
        "CODEX_PATH": codex,
        "CODEX_WORKDIR": str(workdir),
        "CODEX_TELEGRAM_STATE_DIR": str(STATE_ROOT / "state"),
        "TELEGRAM_KEYCHAIN_SERVICE": SERVICE,
        "CODEX_ALLOWED_APPROVAL_POLICIES": "on-request,untrusted",
        "CODEX_APPROVAL_POLICY": "on-request",
        "CODEX_SANDBOX_MODE": "workspace-write",
        "CODEX_WEB_SEARCH": "disabled",
        "CODEX_SKIP_GIT_REPO_CHECK": "false",
        "CODEX_TRANSPORT": "sdk",
        "CODEX_WORKER_MODE": "sidecar",
        "TELEGRAM_LANGUAGE": "en",
        "TELEGRAM_TIME_ZONE": "UTC",
        "TELEGRAM_LOCALE": "en-US",
        "UPLOAD_RETENTION_DAYS": "30",
        "UPLOAD_CLEANUP_ENABLED": "true",
        "CLEANUP_ENABLED": "false",
        "SNAPSHOT_ENABLED": "true",
        "SNAPSHOT_RETENTION_DAYS": "14",
    }
    target = STATE_ROOT / "settings.json"
    previous_settings: bytes | None = target.read_bytes() if target.exists() else None
    if previous_settings is not None:
        existing_value: object = json.loads(previous_settings)
        if not isinstance(existing_value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in existing_value.items()):
            raise SetupError("Existing settings are invalid; setup left them unchanged")
        existing = cast(dict[str, str], existing_value)
        settings = {**settings, **existing, "ALLOWED_USER_IDS": user_id, "ALLOWED_CHAT_IDS": user_id,
                    "CODEX_TELEGRAM_NODE": node, "CODEX_PATH": codex, "CODEX_WORKDIR": str(workdir),
                    "TELEGRAM_KEYCHAIN_SERVICE": SERVICE}
    if settings["CODEX_APPROVAL_POLICY"] not in {"on-request", "untrusted"}:
        raise SetupError("Setup requires on-request or untrusted approval policy")
    if settings["CODEX_ALLOWED_APPROVAL_POLICIES"] != "on-request,untrusted":
        raise SetupError("Setup requires the on-request,untrusted host approval boundary")
    print("Checking Codex SDK before changing settings or Keychain")
    checked = subprocess.run([node, str(BOT_ROOT / "scripts/sdk-smoke.mjs")], env=build_environment(settings, token), cwd=BOT_ROOT, capture_output=True, text=True, timeout=180)
    if checked.returncode != 0:
        raise SetupError("Codex SDK check failed: exit_code=" + str(checked.returncode) + "; existing settings and Keychain were left unchanged")
    previous = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-w"], capture_output=True, text=True, timeout=10)
    if previous.returncode not in {0, 44}:
        raise SetupError("Cannot verify existing Keychain entry: exit_code=" + str(previous.returncode))
    try:
        stored = subprocess.run(["security", "add-generic-password", "-U", "-a", getpass.getuser(), "-s", SERVICE, "-w", token], capture_output=True, text=True, timeout=10)
        if stored.returncode != 0:
            raise SetupError("Keychain credential storage failed: exit_code=" + str(stored.returncode))
        atomic_write(target, (json.dumps(settings, ensure_ascii=False, indent=2) + "\n").encode())
    except (OSError, SetupError, subprocess.SubprocessError):
        if previous.returncode == 0:
            restored = subprocess.run(["security", "add-generic-password", "-U", "-a", getpass.getuser(), "-s", SERVICE, "-w", previous.stdout.strip()], capture_output=True, text=True, timeout=10)
        else:
            restored = subprocess.run(["security", "delete-generic-password", "-s", SERVICE], capture_output=True, text=True, timeout=10)
        if restored.returncode != 0:
            raise SetupError("Configuration rollback could not restore Keychain; inspect setup locally") from None
        if previous_settings is not None:
            atomic_write(target, previous_settings)
        else:
            target.unlink(missing_ok=True)
        raise
    print("Токен и настройки сохранены после успешной проверки")
    print("Реальная проверка Codex SDK прошла")
    print("При запуске бот зарегистрирует меню Telegram и будет отвечать на твои сообщения")
    if input("Запустить бота и включить автозапуск сейчас? [yes/no]: ").strip().lower() != "yes":
        print("Автозапуск не включён. Для запуска повтори эту команду")
        return
    install_service("local.codex.telegram.bridge.worker", ROOT / "run_worker.py")
    install_service("local.codex.telegram.bridge.bot", ROOT / "run_bot.py")
    print("Службы запущены. Открой своего бота в Telegram и отправь /start, затем тестовую задачу")


if __name__ == "__main__":
    main()
