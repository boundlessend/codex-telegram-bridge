"""Prepare a permanent, locked runtime from a checkout or plugin/package cache."""
from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import NamedTuple
from uuid import uuid4

from runtime import BOT_ROOT, STATE_ROOT, RuntimeConfigurationError, ensure_private_directory, atomic_write


class Tools(NamedTuple):
    node: Path
    npm: Path
    python: Path


def check_tools() -> Tools:
    if sys.version_info < (3, 10):
        raise RuntimeConfigurationError("Install Python 3.10 or newer before bridge setup")
    candidates: list[str] = []
    requested = os.environ.get("CODEX_TELEGRAM_NODE")
    if requested:
        candidates.append(requested)
    active = shutil.which("node")
    if active:
        candidates.append(active)
    candidates += ["/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node"]
    node: Path | None = None
    for candidate in dict.fromkeys(candidates):
        if not Path(candidate).is_file():
            continue
        result = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            raise RuntimeConfigurationError("Node version check failed: exit_code=" + str(result.returncode))
        if re.fullmatch(r"v24\.\d+\.\d+", result.stdout.strip()):
            node = Path(candidate).absolute()
            break
    if node is None:
        raise RuntimeConfigurationError("Node.js 24 is required. Install it and put it in PATH, then rerun setup")
    npm = shutil.which("npm", path=str(node.parent) + os.pathsep + os.environ.get("PATH", os.defpath))
    if npm is None:
        raise RuntimeConfigurationError("npm must be available with Node.js 24")
    python = os.environ.get("CODEX_TELEGRAM_PYTHON", sys.executable)
    return Tools(node, Path(npm).absolute(), Path(python).absolute())


def runtime_files(source: Path) -> list[Path]:
    files = [source / name for name in ("package.json", "npm-shrinkwrap.json", "LICENSE", "NOTICE")]
    for directory in ("src", "scripts", "runtime", "bin", "LICENSES"):
        for file in sorted((source / directory).rglob("*")):
            if "__pycache__" in file.parts or file.suffix in {".pyc", ".bak"}:
                continue
            if file.is_symlink():
                raise RuntimeConfigurationError("Runtime source contains a symlink; use a verified package or checkout")
            if file.is_file():
                if directory == "bin" and file.name not in {"codex-telegram-bridge", "codex-telegram-bot", "codex-telegram-worker", "codex-yolo"}:
                    continue
                if directory != "bin" and file.suffix not in {".js", ".mjs", ".py", ".json", ".ts", ".txt"}:
                    continue
                files.append(file)
    for file in files:
        if not file.is_file() or file.is_symlink():
            raise RuntimeConfigurationError("Runtime package is incomplete; obtain a fresh bridge package")
    return files


def runtime_digest(source: Path) -> str:
    digest = hashlib.sha256()
    for file in runtime_files(source):
        digest.update(str(file.relative_to(source)).encode())
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def prepare_runtime(source: Path, tools: Tools, previous: Mapping[str, str]) -> Path:
    digest = runtime_digest(source)
    existing = previous.get("CODEX_TELEGRAM_APP_ROOT")
    apps = STATE_ROOT / "apps"
    ensure_private_directory(apps)
    if existing:
        root = Path(existing)
        if root.is_relative_to(apps) and (root / "installation.json").is_file():
            value: object = json.loads((root / "installation.json").read_text())
            if isinstance(value, dict) and value.get("digest") == digest and runtime_digest(root) == digest:
                if (root / "node_modules/@openai/codex-sdk").is_dir():
                    print("Reusing the verified installed runtime")
                    return root
                raise RuntimeConfigurationError("Installed dependencies are incomplete; inspect the runtime before updating")
    root = apps / ("install-" + uuid4().hex)
    ensure_private_directory(root)
    for file in runtime_files(source):
        target = root / file.relative_to(source)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        target.chmod(0o700 if os.access(file, os.X_OK) else 0o600)
    environment = dict(os.environ)
    environment["PATH"] = str(tools.node.parent) + os.pathsep + environment.get("PATH", os.defpath)
    print("Installing locked runtime dependencies in the private application folder")
    result = subprocess.run([str(tools.npm), "ci", "--omit=dev", "--ignore-scripts", "--audit=false"], cwd=root, env=environment, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeConfigurationError("Runtime dependency installation failed: exit_code=" + str(result.returncode) + "; inspect npm connectivity and rerun setup")
    atomic_write(root / "installation.json", (json.dumps({"digest": digest, "source": "codex-telegram-bridge"}) + "\n").encode())
    return root


def select_codex(app: Path, previous: Mapping[str, str]) -> Path:
    current = shutil.which("codex")
    configured = previous.get("CODEX_PATH")
    choices: list[str] = []
    if configured:
        choices.append(configured)
    if current:
        choices.append(current)
    for choice in choices:
        candidate = Path(choice).absolute()
        if candidate.is_file() and "/plugins/cache/" not in str(candidate) and not candidate.is_relative_to(BOT_ROOT) and not candidate.is_relative_to(STATE_ROOT / "apps"):
            return candidate
    bundled = app / "node_modules/.bin/codex"
    if not bundled.is_file():
        raise RuntimeConfigurationError("The locked runtime did not provide its Codex CLI")
    print("Using the Codex CLI bundled with the permanent runtime")
    return bundled


def ensure_codex_login(codex: Path, tools: Tools) -> None:
    environment = dict(os.environ)
    environment["PATH"] = str(tools.node.parent) + os.pathsep + environment.get("PATH", os.defpath)
    result = subprocess.run([str(codex), "login", "status"], env=environment, capture_output=True, text=True, timeout=15)
    if result.returncode == 0:
        print("Existing Codex login is ready")
        return
    if result.returncode != 1:
        raise RuntimeConfigurationError("Codex login status failed: exit_code=" + str(result.returncode))
    if input("Codex needs sign-in. Open its local login flow now? [yes/no]: ").strip().lower() != "yes":
        raise RuntimeConfigurationError("Complete codex login locally, then rerun setup")
    logged = subprocess.run([str(codex), "login"], env=environment, timeout=300)
    if logged.returncode != 0:
        raise RuntimeConfigurationError("Codex login failed: exit_code=" + str(logged.returncode))
