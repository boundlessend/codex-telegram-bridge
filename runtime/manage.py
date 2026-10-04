#!/usr/bin/env python3
"""Inspect and control this installation's macOS LaunchAgents."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from runtime import BOT_ROOT, STATE_ROOT, RuntimeConfigurationError, read_settings


LABELS = ("local.codex.telegram.bridge.worker", "local.codex.telegram.bridge.bot")


def service_loaded(label: str) -> bool:
    result = subprocess.run(["launchctl", "print", "gui/" + str(os.getuid()) + "/" + label], capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        return True
    if "Could not find service" in result.stderr:
        return False
    raise RuntimeConfigurationError("LaunchAgent lookup failed: exit_code=" + str(result.returncode))


def start_services() -> None:
    for label in LABELS:
        if service_loaded(label):
            continue
        plist = Path.home() / "Library/LaunchAgents" / (label + ".plist")
        if not plist.is_file():
            raise RuntimeConfigurationError("Run runtime/setup.py before starting services")
        subprocess.run(["launchctl", "bootstrap", "gui/" + str(os.getuid()), str(plist)], check=True, timeout=15)


def stop_services() -> None:
    for label in reversed(LABELS):
        if service_loaded(label):
            subprocess.run(["launchctl", "bootout", "gui/" + str(os.getuid()) + "/" + label], check=True, timeout=15)


def restart_services() -> None:
    stop_services()
    start_services()


def doctor() -> bool:
    tools = {name: shutil.which(name) is not None for name in ("node", "codex", "exiftool", "qpdf")}
    settings_ready = False
    if (STATE_ROOT / "settings.json").is_file():
        settings = read_settings()
        settings_ready = all(name in settings for name in ("CODEX_TELEGRAM_NODE", "CODEX_WORKDIR", "ALLOWED_USER_IDS"))
    report: dict[str, object] = {
        "macos_runtime_supported": sys.platform == "darwin",
        "tools": tools,
        "dependencies_installed": (BOT_ROOT / "node_modules/@openai/codex-sdk").is_dir(),
        "settings_ready": settings_ready,
        "credentials_checked": False,
    }
    print(json.dumps(report))
    return all(tools.values()) and bool(report["dependencies_installed"]) and settings_ready


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("doctor", "status", "start", "stop", "restart"))
    args = parser.parse_args()
    if args.action == "doctor":
        if not doctor():
            raise SystemExit(1)
        return
    if sys.platform != "darwin":
        raise RuntimeConfigurationError("This manager requires macOS; use systemctl on Linux")
    if args.action == "status":
        print(json.dumps({label: service_loaded(label) for label in LABELS}))
    elif args.action == "start":
        start_services()
    elif args.action == "stop":
        stop_services()
    elif args.action == "restart":
        restart_services()


if __name__ == "__main__":
    main()
