#!/usr/bin/env python3
"""Inspect or control the permanent bridge on macOS and Linux."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys

from runtime import BOT_ROOT, STATE_ROOT, RuntimeConfigurationError, installed_root, read_settings
from services import ROLES, ServiceManager


def doctor() -> bool:
    settings: dict[str, str] = {}
    if (STATE_ROOT / "settings.json").is_file():
        settings = read_settings()
    tools = {name: shutil.which(name) is not None for name in ("node", "codex", "exiftool", "qpdf")}
    for name, key in [("node", "CODEX_TELEGRAM_NODE"), ("codex", "CODEX_PATH")]:
        if settings.get(key):
            tools[name] = Path(settings[key]).is_file()
    root = BOT_ROOT
    settings_ready = all(key in settings for key in ("CODEX_TELEGRAM_APP_ROOT", "CODEX_TELEGRAM_NODE", "CODEX_WORKDIR", "ALLOWED_USER_IDS"))
    if settings_ready:
        root = installed_root(settings)
    dependencies = (root / "node_modules/@openai/codex-sdk").is_dir()
    report: dict[str, object] = {
        "macos_runtime_supported": sys.platform == "darwin",
        "platform_supported": sys.platform in {"darwin", "linux"}, "tools": tools,
        "dependencies_installed": dependencies, "settings_ready": settings_ready,
        "credentials_checked": False, "optional_file_tools_ready": tools["exiftool"] and tools["qpdf"]
    }
    print(json.dumps(report))
    return bool(report["platform_supported"]) and tools["node"] and tools["codex"] and dependencies and settings_ready


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("doctor", "status", "start", "stop", "restart", "uninstall"))
    args = parser.parse_args()
    if args.action == "doctor":
        if not doctor():
            raise SystemExit(1)
        return
    manager = ServiceManager(sys.platform, Path.home())
    if args.action == "status":
        print(json.dumps({role: manager.state(role) for role in ROLES}))
    elif args.action == "start":
        manager.start()
    elif args.action == "stop":
        manager.stop()
    elif args.action == "restart":
        manager.stop()
        manager.start()
    elif args.action == "uninstall":
        manager.unregister(read_settings())
        print("Bridge user services unregistered. Local settings, credentials and history are retained")


if __name__ == "__main__":
    try:
        main()
    except RuntimeConfigurationError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
