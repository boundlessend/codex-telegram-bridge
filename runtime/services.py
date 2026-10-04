"""Generate and control this bridge's user services without exposing credentials."""
from __future__ import annotations

from collections.abc import Mapping
import os
from pathlib import Path
import plistlib
import subprocess
from typing import Literal, TypedDict

from runtime import STATE_ROOT, RuntimeConfigurationError, atomic_write, installed_root


Role = Literal["worker", "bot"]
ROLES: tuple[Role, Role] = ("worker", "bot")


class ServiceState(TypedDict):
    registered: bool
    running: bool


def service_label(role: Role, platform: str) -> str:
    if platform == "darwin":
        return "local.codex.telegram.bridge." + role
    return "codex-telegram-bridge-" + role + ".service"


def service_file(role: Role, platform: str, home: Path) -> Path:
    if platform == "darwin":
        return home / "Library/LaunchAgents" / (service_label(role, platform) + ".plist")
    return home / ".config/systemd/user" / service_label(role, platform)


def launch_agent(role: Role, settings: Mapping[str, str], python: Path) -> bytes:
    root = installed_root(settings)
    label = service_label(role, "darwin")
    value: dict[str, object] = {
        "Label": label,
        "ProgramArguments": [str(python), str(root / "runtime" / ("run_" + role + ".py"))],
        "WorkingDirectory": str(root),
        "EnvironmentVariables": {
            "PATH": str(Path(settings["CODEX_TELEGRAM_NODE"]).parent) + os.pathsep + os.environ.get("PATH", os.defpath),
            "HOME": str(Path.home()), "CODEX_TELEGRAM_RUNTIME_DIR": str(STATE_ROOT)
        },
        "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 10,
        "StandardOutPath": str(STATE_ROOT / "logs" / (label + ".stdout.log")),
        "StandardErrorPath": str(STATE_ROOT / "logs" / (label + ".stderr.log")),
    }
    return plistlib.dumps(value)


def systemd_argument(value: str) -> str:
    if "\n" in value or "\r" in value or "\0" in value:
        raise RuntimeConfigurationError("Service paths must not contain line breaks")
    return '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'


def systemd_exec_argument(value: str) -> str:
    return systemd_argument(value.replace("$", "$$"))


def systemd_unit(role: Role, settings: Mapping[str, str], python: Path) -> bytes:
    root = installed_root(settings)
    lines = ["# Managed by codex-telegram-bridge", "[Unit]", "Description=Codex Telegram Bridge " + role]
    if role == "bot":
        lines += ["Wants=" + service_label("worker", "linux"), "After=" + service_label("worker", "linux")]
    lines += [
        "[Service]", "Type=simple", "UMask=0077",
        "WorkingDirectory=" + systemd_argument(str(root)),
        "Environment=" + systemd_argument("CODEX_TELEGRAM_RUNTIME_DIR=" + str(STATE_ROOT)),
        "ExecStart=" + systemd_exec_argument(str(python)) + " " + systemd_exec_argument(str(root / "runtime" / ("run_" + role + ".py"))),
        "Restart=on-failure", "RestartSec=5", "[Install]", "WantedBy=default.target", ""
    ]
    return "\n".join(lines).encode()


class ServiceManager:
    def __init__(self, platform: str, home: Path) -> None:
        if platform not in {"darwin", "linux"}:
            raise RuntimeConfigurationError("Service management supports macOS and Linux")
        self.platform = platform
        self.home = home

    def command(self, arguments: list[str]) -> None:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeConfigurationError(arguments[0] + " service operation failed: exit_code=" + str(result.returncode))

    def state(self, role: Role) -> ServiceState:
        label = service_label(role, self.platform)
        if self.platform == "darwin":
            result = subprocess.run(["launchctl", "print", "gui/" + str(os.getuid()) + "/" + label], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                return {"registered": True, "running": "state = running" in result.stdout}
            if "Could not find service" in result.stderr:
                return {"registered": False, "running": False}
            raise RuntimeConfigurationError("LaunchAgent lookup failed: exit_code=" + str(result.returncode))
        result = subprocess.run(["systemctl", "--user", "is-active", label], capture_output=True, text=True, timeout=10)
        if result.returncode not in {0, 3, 4}:
            raise RuntimeConfigurationError("systemd lookup failed: exit_code=" + str(result.returncode))
        return {"registered": service_file(role, self.platform, self.home).is_file(), "running": result.returncode == 0}

    def reload(self) -> None:
        if self.platform == "linux":
            self.command(["systemctl", "--user", "daemon-reload"])

    def start(self) -> None:
        for role in ROLES:
            label = service_label(role, self.platform)
            file = service_file(role, self.platform, self.home)
            if not file.is_file():
                raise RuntimeConfigurationError("Run bridge setup to register its user services")
            if self.platform == "darwin":
                if not self.state(role)["registered"]:
                    self.command(["launchctl", "bootstrap", "gui/" + str(os.getuid()), str(file)])
            else:
                self.command(["systemctl", "--user", "enable", label])
                self.command(["systemctl", "--user", "start", label])

    def stop(self) -> None:
        for role in reversed(ROLES):
            label = service_label(role, self.platform)
            if self.platform == "darwin":
                if self.state(role)["registered"]:
                    self.command(["launchctl", "bootout", "gui/" + str(os.getuid()) + "/" + label])
            elif self.state(role)["running"]:
                self.command(["systemctl", "--user", "stop", label])

    def unregister(self, settings: Mapping[str, str]) -> None:
        root = str(installed_root(settings))
        for role in ROLES:
            file = service_file(role, self.platform, self.home)
            if file.is_file():
                if self.platform == "darwin":
                    owned = plistlib.loads(file.read_bytes()).get("WorkingDirectory") == root
                else:
                    owned = "WorkingDirectory=" + systemd_argument(root) in file.read_text()
                if not owned:
                    raise RuntimeConfigurationError("Service definition ownership is unclear; inspect it locally before uninstalling")
        self.stop()
        for role in ROLES:
            label = service_label(role, self.platform)
            if self.platform == "linux" and service_file(role, self.platform, self.home).is_file():
                self.command(["systemctl", "--user", "disable", label])
            service_file(role, self.platform, self.home).unlink(missing_ok=True)
        self.reload()


def install_services(settings: Mapping[str, str], python: Path, manager: ServiceManager) -> None:
    logs = STATE_ROOT / "logs"
    logs.mkdir(mode=0o700, exist_ok=True)
    for role in ROLES:
        file = service_file(role, manager.platform, manager.home)
        file.parent.mkdir(parents=True, exist_ok=True)
        if manager.platform == "darwin":
            for suffix in ("stdout", "stderr"):
                log = logs / (service_label(role, manager.platform) + "." + suffix + ".log")
                log.touch(mode=0o600, exist_ok=True)
                log.chmod(0o600)
            content = launch_agent(role, settings, python)
        else:
            content = systemd_unit(role, settings, python)
        atomic_write(file, content)
    manager.reload()
