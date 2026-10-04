"""Interactive local setup; credentials never pass through a Codex conversation."""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import TypedDict, cast
import urllib.error
import urllib.request

from install import Tools, check_tools, ensure_codex_login, prepare_runtime, select_codex
from runtime import (
    BOT_ROOT, SERVICE, STATE_ROOT, RuntimeConfigurationError, atomic_write,
    build_environment, ensure_private_directory, read_settings, remove_credential,
    saved_credential, write_credential
)
from services import ROLES, ServiceManager, install_services, service_file, service_label


class BotIdentity(TypedDict):
    id: int
    is_bot: bool
    username: str


def bot_identity(token: str) -> BotIdentity:
    for attempt in range(3):
        try:
            with urllib.request.urlopen("https://api.telegram.org/bot" + token + "/getMe", timeout=15) as response:
                value: object = json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code >= 500 and attempt < 2:
                print("Telegram server is unavailable; retrying identity check")
                continue
            raise RuntimeConfigurationError("Telegram identity check failed: HTTP " + str(error.code)) from None
        except urllib.error.URLError:
            if attempt == 2:
                raise RuntimeConfigurationError("Telegram is unreachable after three attempts") from None
            print("Telegram is unreachable; retrying identity check")
            continue
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise RuntimeConfigurationError("Telegram did not confirm the bot token")
        result: object = value.get("result")
        if not isinstance(result, dict) or result.get("is_bot") is not True or not isinstance(result.get("id"), int):
            raise RuntimeConfigurationError("Telegram returned an invalid bot identity")
        return cast(BotIdentity, result)
    raise RuntimeConfigurationError("Telegram identity check did not complete")


def select_workdir(value: Path | None) -> Path:
    if value is None:
        value = Path(input("Trusted Git project directory: ").strip())
    root = value.expanduser().resolve(strict=True)
    if not root.is_dir():
        raise RuntimeConfigurationError("Choose an existing Git project directory")
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise RuntimeConfigurationError("Choose a directory inside an existing trusted Git repository")
    return root


def pair_owner(app: Path, tools: Tools, token: str) -> tuple[str, str]:
    environment = dict(os.environ)
    environment["PATH"] = str(tools.node.parent) + os.pathsep + environment.get("PATH", os.defpath)
    child = subprocess.Popen([str(tools.node), str(app / "scripts/pair-telegram.mjs")],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=environment, cwd=app)
    if child.stdin is None or child.stdout is None:
        raise RuntimeConfigurationError("Pairing process could not open its private input channel")
    result: tuple[str, str] | None = None
    failure = "Telegram pairing failed; stop other bridge instances and check the connection"
    try:
        child.stdin.write(json.dumps({"token": token}))
        child.stdin.close()
        for line in child.stdout:
            value: object = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeConfigurationError("Pairing returned an invalid event")
            if value.get("event") == "pair_link":
                url = value.get("url")
                if not isinstance(url, str) or not url.startswith("https://t.me/"):
                    raise RuntimeConfigurationError("Pairing returned an invalid link")
                print("Open this one-time link in your Telegram account within five minutes:")
                print(url, flush=True)
            elif value.get("event") == "paired":
                user_id, bot_id = value.get("userId"), value.get("botId")
                if not isinstance(user_id, str) or not isinstance(bot_id, str) or not user_id.isdecimal() or not bot_id.isdecimal():
                    raise RuntimeConfigurationError("Pairing returned invalid account identifiers")
                result = (user_id, bot_id)
            elif value.get("event") == "error":
                message = value.get("message")
                if isinstance(message, str):
                    failure = message
        code = child.wait(timeout=10)
        if code != 0 or result is None:
            raise RuntimeConfigurationError(failure)
        return result
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        child.stdout.close()
        if child.stderr is not None:
            child.stderr.close()


def settings_for_install(app: Path, tools: Tools, codex: Path, workdir: Path, previous: dict[str, str]) -> dict[str, str]:
    defaults = {
        "CODEX_APPROVAL_POLICY": "on-request", "CODEX_SANDBOX_MODE": "workspace-write",
        "CODEX_WEB_SEARCH": "disabled", "CODEX_SKIP_GIT_REPO_CHECK": "false",
        "CODEX_TRANSPORT": "sdk", "CODEX_WORKER_MODE": "sidecar",
        "TELEGRAM_LANGUAGE": "en", "TELEGRAM_TIME_ZONE": "UTC", "TELEGRAM_LOCALE": "en-US",
        "UPLOAD_RETENTION_DAYS": "30", "UPLOAD_CLEANUP_ENABLED": "true", "CLEANUP_ENABLED": "false",
        "SNAPSHOT_ENABLED": "true", "SNAPSHOT_RETENTION_DAYS": "14"
    }
    settings = {**defaults, **previous,
                "CODEX_WORKDIR": str(workdir), "CODEX_PATH": str(codex), "CODEX_TELEGRAM_NODE": str(tools.node),
                "CODEX_TELEGRAM_APP_ROOT": str(app), "CODEX_TELEGRAM_PYTHON": str(tools.python),
                "FILE_METADATA_PYTHON": str(tools.python), "CODEX_TELEGRAM_STATE_DIR": str(STATE_ROOT / "state"),
                "CODEX_WORKER_SOCKET": str(STATE_ROOT / "worker.sock"),
                "TELEGRAM_KEYCHAIN_SERVICE": SERVICE, "CODEX_ALLOWED_APPROVAL_POLICIES": "on-request,untrusted",
                "CODEX_UPDATE_BOT_SERVICE": service_label("bot", sys.platform),
                "CODEX_UPDATE_WORKER_SERVICE": service_label("worker", sys.platform)}
    for name in ("CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        if name in os.environ and name not in settings:
            settings[name] = os.environ[name]
    if settings["CODEX_APPROVAL_POLICY"] not in {"on-request", "untrusted"}:
        raise RuntimeConfigurationError("Bridge setup requires on-request or untrusted approvals")
    return settings


def commit_configuration(settings: dict[str, str], token: str, tools: Tools, manager: ServiceManager) -> None:
    target = STATE_ROOT / "settings.json"
    old_settings = target.read_bytes() if target.exists() else None
    old_token = saved_credential()
    old_services = {role: service_file(role, manager.platform, manager.home).read_bytes()
                    if service_file(role, manager.platform, manager.home).is_file() else None for role in ROLES}
    try:
        write_credential(token)
        atomic_write(target, (json.dumps(settings, indent=2) + "\n").encode())
        install_services(settings, tools.python, manager)
    except (OSError, RuntimeConfigurationError, subprocess.SubprocessError):
        if old_token is None:
            if saved_credential() is not None:
                remove_credential()
        else:
            write_credential(old_token)
        if old_settings is None:
            target.unlink(missing_ok=True)
        else:
            atomic_write(target, old_settings)
        for role, content in old_services.items():
            file = service_file(role, manager.platform, manager.home)
            if content is None:
                file.unlink(missing_ok=True)
            else:
                atomic_write(file, content)
        manager.reload()
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", type=Path)
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeConfigurationError("Run setup in your own interactive terminal; never provide bot tokens through chat or redirected input")
    os.umask(0o077)
    tools = check_tools()
    workdir = select_workdir(args.workdir)
    ensure_private_directory(STATE_ROOT)
    target = STATE_ROOT / "settings.json"
    previous = read_settings() if target.exists() else {}
    manager = ServiceManager(sys.platform, Path.home())
    states = [manager.state(role) for role in ROLES]
    if any(state["running"] or (sys.platform == "darwin" and state["registered"]) for state in states):
        raise RuntimeConfigurationError("Stop this bridge with the stop command before updating its runtime")
    app = prepare_runtime(BOT_ROOT, tools, previous)
    codex = select_codex(app, previous)
    ensure_codex_login(codex, tools)
    existing_token = saved_credential()
    token = getpass.getpass("Telegram bot token (empty keeps a saved token): ").strip()
    if not token and existing_token:
        token = existing_token
    if re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token) is None:
        raise RuntimeConfigurationError("A valid Telegram bot token is required")
    identity = bot_identity(token)
    if existing_token and previous and token.split(":")[0] != existing_token.split(":")[0]:
        raise RuntimeConfigurationError("This runtime belongs to another bot. Configure a separate CODEX_TELEGRAM_RUNTIME_DIR")
    settings = settings_for_install(app, tools, codex, workdir, previous)
    reusable_owner = existing_token == token and bool(previous.get("ALLOWED_USER_IDS"))
    if not reusable_owner:
        user_id, bot_id = pair_owner(app, tools, token)
        if bot_id != str(identity["id"]):
            raise RuntimeConfigurationError("Telegram pairing bot identity changed")
        settings["ALLOWED_USER_IDS"] = user_id
        settings["ALLOWED_CHAT_IDS"] = user_id
        if previous.get("ALLOWED_USER_IDS") and user_id not in previous["ALLOWED_USER_IDS"].split(","):
            raise RuntimeConfigurationError("Changing the owner requires a separate runtime directory so private history stays with its original owner")
    settings["TELEGRAM_EXPECTED_BOT_ID"] = str(identity["id"])
    print("Checking a real read-only Codex response before changing credentials or services")
    checked = subprocess.run([str(tools.node), str(app / "scripts/sdk-smoke.mjs")], env=build_environment(settings, token), cwd=app,
                             capture_output=True, text=True, timeout=180)
    if checked.returncode != 0:
        raise RuntimeConfigurationError("Codex SDK check failed: exit_code=" + str(checked.returncode) + "; existing configuration was left unchanged")
    commit_configuration(settings, token, tools, manager)
    print("Setup complete. Credentials and settings are stored outside the plugin cache")
    if input("Enable login autostart and start the bridge now? [yes/no]: ").strip().lower() == "yes":
        manager.start()
        print("Services started. Send your bot a small test task to confirm end-to-end delivery")
    else:
        print("User service definitions are ready. Use the start command when you are ready")


if __name__ == "__main__":
    try:
        main()
    except RuntimeConfigurationError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print("Setup operation failed: " + type(error).__name__ + "; inspect the local prerequisites and rerun setup", file=sys.stderr)
        raise SystemExit(2) from None
