#!/usr/bin/env python3
"""Backup-first Codex state maintenance helper for Telegram buttons."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


PROJECT_HEADER_RE = re.compile(r"^\[projects\.([\"'])(.+)\1\]\s*$")
TEMP_PROJECT_RE = re.compile(r"(\\Temp\\codex-|/Temp/codex-|\\Temp\\spark-|/Temp/spark-)", re.I)


@dataclass
class ThreadMetadataRepair:
    thread_id: str
    old_title: str
    new_title: str
    old_preview: str
    new_preview: str


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            pass
    return total


def count_files(path: Path, pattern: str = "*") -> int:
    if not path.exists():
        return 0
    try:
        return sum(1 for item in path.rglob(pattern) if item.is_file())
    except OSError:
        return 0


def copy_if_exists(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(
            src,
            dst,
            ignore=shutil.ignore_patterns("node_modules", ".git", ".next", "dist", "build", ".venv", "__pycache__"),
            dirs_exist_ok=True,
        )
    else:
        shutil.copy2(src, dst)


def sqlite_backup(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"{src.resolve().as_uri()}?mode=ro", uri=True)
    target = sqlite3.connect(dst)
    source.backup(target)
    target.close()
    source.close()


def backup_metadata(codex_home: Path, backup_root: Path) -> list[str]:
    copied: list[str] = []
    backup_root.mkdir(parents=True, exist_ok=True)
    for name in [
        ".codex-global-state.json",
        "config.toml",
        "history.jsonl",
        "installation_id",
        "models_cache.json",
        "session_index.jsonl",
        "version.json",
        "memories",
        "skills",
        "rules",
        "plugins",
        "automations",
    ]:
        src = codex_home / name
        if src.exists():
            copy_if_exists(src, backup_root / name)
            copied.append(name)
    if (codex_home / "state_5.sqlite").exists():
        sqlite_backup(codex_home / "state_5.sqlite", backup_root / "state_5.sqlite")
        copied.append("state_5.sqlite")
    return copied


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row[1] for row in conn.execute(f'pragma table_info("{table}")').fetchall()}
    except sqlite3.Error:
        return set()


def bounded_text(value: str, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def append_session_index_name(codex_home: Path, thread_id: str, name: str) -> None:
    path = codex_home / "session_index.jsonl"
    entry = {
        "id": thread_id,
        "thread_name": name,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def metadata_bloat(codex_home: Path, title_limit: int, preview_limit: int) -> dict[str, Any]:
    db = codex_home / "state_5.sqlite"
    if not db.exists():
        return {"available": False}
    conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)
    try:
        cols = table_columns(conn, "threads")
        if not {"id", "title"}.issubset(cols):
            return {"available": False, "reason": "missing_threads_columns"}
        archived_expr = "COALESCE(archived,0)=0" if "archived" in cols else "archived_at is null"
        has_preview = "first_user_message" in cols
        if has_preview:
            row = conn.execute(
                f"""
                select
                  count(*),
                  coalesce(sum(length(title)), 0),
                  coalesce(sum(length(first_user_message)), 0),
                  coalesce(max(length(title)), 0),
                  coalesce(max(length(first_user_message)), 0),
                  sum(case when length(title) > ? then 1 else 0 end),
                  sum(case when length(first_user_message) > ? then 1 else 0 end),
                  sum(case when length(first_user_message) > 10000 then 1 else 0 end)
                from threads
                where {archived_expr}
                """,
                (title_limit, preview_limit),
            ).fetchone()
            return {
                "available": True,
                "activeRows": row[0],
                "titleChars": row[1],
                "previewChars": row[2],
                "maxTitleChars": row[3],
                "maxPreviewChars": row[4],
                "titlesOverLimit": row[5] or 0,
                "previewsOverLimit": row[6] or 0,
                "previewsOver10k": row[7] or 0,
            }
        row = conn.execute(
            f"""
            select count(*), coalesce(sum(length(title)), 0), coalesce(max(length(title)), 0),
                   sum(case when length(title) > ? then 1 else 0 end)
            from threads
            where {archived_expr}
            """,
            (title_limit,),
        ).fetchone()
        return {
            "available": True,
            "activeRows": row[0],
            "titleChars": row[1],
            "previewChars": 0,
            "maxTitleChars": row[2],
            "maxPreviewChars": 0,
            "titlesOverLimit": row[3] or 0,
            "previewsOverLimit": 0,
            "previewsOver10k": 0,
        }
    finally:
        conn.close()


def repair_thread_metadata_bloat(codex_home: Path, backup_root: Path, title_limit: int, preview_limit: int) -> dict[str, Any]:
    db = codex_home / "state_5.sqlite"
    if not db.exists():
        return {"available": False, "reason": "state_db_missing", "repaired": 0}
    conn = sqlite3.connect(db)
    conn.execute("pragma busy_timeout=10000")
    try:
        cols = table_columns(conn, "threads")
        if not {"id", "title"}.issubset(cols):
            return {"available": False, "reason": "missing_threads_columns", "repaired": 0}
        has_preview = "first_user_message" in cols
        archived_expr = "COALESCE(archived,0)=0" if "archived" in cols else "archived_at is null"
        select_preview = "first_user_message" if has_preview else "''"
        rows = conn.execute(
            f"""
            select id, title, {select_preview}
            from threads
            where {archived_expr}
              and (
                length(title) > ?
                {"or length(first_user_message) > ?" if has_preview else ""}
              )
            """,
            (title_limit, preview_limit) if has_preview else (title_limit,),
        ).fetchall()

        repairs: list[ThreadMetadataRepair] = []
        for thread_id, title, preview in rows:
            old_title = title or ""
            old_preview = preview or ""
            new_title = bounded_text(old_title, title_limit)
            new_preview = bounded_text(old_preview, preview_limit) if has_preview else ""
            if new_title != old_title or new_preview != old_preview:
                repairs.append(ThreadMetadataRepair(str(thread_id), old_title, new_title, old_preview, new_preview))

        manifest = backup_root / "thread-metadata-repairs.jsonl"
        if repairs:
            with manifest.open("w", encoding="utf-8") as handle:
                for item in repairs:
                    handle.write(json.dumps({
                        "thread_id": item.thread_id,
                        "old_title": item.old_title,
                        "new_title": item.new_title,
                        "old_first_user_message": item.old_preview,
                        "new_first_user_message": item.new_preview,
                    }, ensure_ascii=False) + "\n")
            for item in repairs:
                if has_preview:
                    conn.execute(
                        "update threads set title=?, first_user_message=? where id=?",
                        (item.new_title, item.new_preview, item.thread_id),
                    )
                else:
                    conn.execute("update threads set title=? where id=?", (item.new_title, item.thread_id))
                if item.new_title and item.new_title != item.old_title:
                    append_session_index_name(codex_home, item.thread_id, item.new_title)
            conn.commit()
            write_thread_metadata_restore_script(manifest, db, backup_root)

        return {
            "available": True,
            "candidates": len(repairs),
            "repaired": len(repairs),
            "titleLimit": title_limit,
            "previewLimit": preview_limit,
            "manifest": str(manifest) if repairs else "",
            "restoreScript": str(backup_root / "restore-thread-metadata.py") if repairs else "",
        }
    finally:
        conn.close()


def write_thread_metadata_restore_script(manifest: Path, state_db: Path, backup_root: Path) -> None:
    restore = backup_root / "restore-thread-metadata.py"
    restore.write_text(
        f'''#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

manifest = Path(r"{manifest}")
db = Path(r"{state_db}")
conn = sqlite3.connect(db)
conn.execute("pragma busy_timeout=10000")
cols = {{row[1] for row in conn.execute('pragma table_info("threads")').fetchall()}}
has_preview = "first_user_message" in cols
for line in manifest.read_text(encoding="utf-8").splitlines():
    rec = json.loads(line)
    if has_preview:
        conn.execute(
            "update threads set title=?, first_user_message=? where id=?",
            (rec["old_title"], rec["old_first_user_message"], rec["thread_id"]),
        )
    else:
        conn.execute("update threads set title=? where id=?", (rec["old_title"], rec["thread_id"]))
conn.commit()
conn.close()
''',
        encoding="utf-8",
    )
    restore.chmod(0o755)


def config_prune_candidates(codex_home: Path) -> list[str]:
    config = codex_home / "config.toml"
    if not config.exists():
        return []
    lines = config.read_text(encoding="utf-8-sig").splitlines()
    candidates: list[str] = []
    i = 0
    while i < len(lines):
        match = PROJECT_HEADER_RE.match(lines[i])
        if not match:
            i += 1
            continue
        project_path = match.group(2)
        i += 1
        while i < len(lines) and not lines[i].startswith("["):
            i += 1
        if TEMP_PROJECT_RE.search(project_path) or not Path(project_path).exists():
            candidates.append(project_path)
    return candidates


def prune_config(codex_home: Path, backup_root: Path | None, apply: bool) -> dict[str, Any]:
    config = codex_home / "config.toml"
    if not config.exists():
        return {"candidates": 0, "applied": False}
    lines = config.read_text(encoding="utf-8-sig").splitlines()
    out: list[str] = []
    removed: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        match = PROJECT_HEADER_RE.match(line)
        if not match:
            out.append(line)
            i += 1
            continue
        project_path = match.group(2)
        block = [line]
        i += 1
        while i < len(lines) and not lines[i].startswith("["):
            block.append(lines[i])
            i += 1
        if TEMP_PROJECT_RE.search(project_path) or not Path(project_path).exists():
            removed.append(project_path)
        else:
            out.extend(block)
    if backup_root:
        (backup_root / "pruned-projects.txt").write_text("\n".join(removed) + ("\n" if removed else ""), encoding="utf-8")
    if apply and removed:
        config.write_text("\n".join(out) + "\n", encoding="utf-8")
    return {"candidates": len(removed), "applied": bool(apply and removed), "manifest": str(backup_root / "pruned-projects.txt") if backup_root else ""}


def stale_worktrees(codex_home: Path, days: int) -> list[Path]:
    root = codex_home / "worktrees"
    if not root.exists():
        return []
    cutoff = time.time() - days * 86400
    return [item for item in root.iterdir() if item.is_dir() and item.stat().st_mtime < cutoff]


def archive_worktrees(codex_home: Path, backup_root: Path, days: int, stamp: str) -> dict[str, Any]:
    candidates = stale_worktrees(codex_home, days)
    archive_root = codex_home / "archived_worktrees" / f"telegram-maintenance-{stamp}"
    manifest = backup_root / "moved-worktrees.jsonl"
    moved = 0
    bytes_total = 0
    if candidates:
        archive_root.mkdir(parents=True, exist_ok=True)
        with manifest.open("w", encoding="utf-8") as handle:
            for source in candidates:
                dest = archive_root / source.name
                item_size = size_bytes(source)
                shutil.move(str(source), str(dest))
                handle.write(json.dumps({"from": str(source), "to": str(dest), "bytes": item_size}, ensure_ascii=False) + "\n")
                moved += 1
                bytes_total += item_size
    return {"candidates": len(candidates), "moved": moved, "bytes": bytes_total, "archiveRoot": str(archive_root), "manifest": str(manifest)}


def log_files(codex_home: Path) -> list[Path]:
    return [item for item in codex_home.glob("logs_2.sqlite*") if item.is_file()]


def rotate_logs(codex_home: Path, backup_root: Path, threshold_mb: int, stamp: str) -> dict[str, Any]:
    files = log_files(codex_home)
    total = sum(item.stat().st_size for item in files)
    threshold = threshold_mb * 1024 * 1024
    if total < threshold:
        return {"files": len(files), "bytes": total, "thresholdMb": threshold_mb, "rotated": 0, "skipped": "below_threshold"}
    archive_root = codex_home / "archived_logs" / f"telegram-maintenance-{stamp}"
    manifest = backup_root / "moved-logs.jsonl"
    archive_root.mkdir(parents=True, exist_ok=True)
    rotated = 0
    with manifest.open("w", encoding="utf-8") as handle:
        for source in files:
            dest = archive_root / source.name
            item_size = source.stat().st_size
            shutil.move(str(source), str(dest))
            handle.write(json.dumps({"from": str(source), "to": str(dest), "bytes": item_size}, ensure_ascii=False) + "\n")
            rotated += 1
    return {"files": len(files), "bytes": total, "thresholdMb": threshold_mb, "rotated": rotated, "archiveRoot": str(archive_root), "manifest": str(manifest)}


def top_node_processes(limit: int = 5) -> list[dict[str, Any]]:
    try:
        output = subprocess.check_output(["ps", "-axo", "pid=,rss=,comm=,args="], text=True)
    except Exception:
        return []
    rows = []
    for line in output.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) >= 3 and "node" in parts[2].lower():
            rows.append({"pid": parts[0], "mb": round(int(parts[1]) / 1024, 1), "command": parts[3][:120] if len(parts) > 3 else parts[2]})
    rows.sort(key=lambda item: item["mb"], reverse=True)
    return rows[:limit]


def report_state(codex_home: Path, args: argparse.Namespace) -> dict[str, Any]:
    sessions = codex_home / "sessions"
    archived_sessions = codex_home / "archived_sessions"
    worktrees = codex_home / "worktrees"
    archived_worktrees = codex_home / "archived_worktrees"
    logs = log_files(codex_home)
    stale = stale_worktrees(codex_home, args.worktree_older_than_days)
    return {
        "action": "report",
        "codexHome": str(codex_home),
        "sessions": {"files": count_files(sessions, "*.jsonl"), "bytes": size_bytes(sessions)},
        "archivedSessions": {"files": count_files(archived_sessions, "*.jsonl"), "bytes": size_bytes(archived_sessions)},
        "worktrees": {"count": len([p for p in worktrees.iterdir() if p.is_dir()]) if worktrees.exists() else 0, "bytes": size_bytes(worktrees)},
        "archivedWorktrees": {"bytes": size_bytes(archived_worktrees)},
        "logs": {"files": len(logs), "bytes": sum(item.stat().st_size for item in logs), "rotateThresholdMb": args.rotate_logs_above_mb},
        "configPrune": {"candidates": len(config_prune_candidates(codex_home))},
        "staleWorktrees": {"candidates": len(stale), "bytes": sum(size_bytes(item) for item in stale), "olderThanDays": args.worktree_older_than_days},
        "metadataBloat": metadata_bloat(codex_home, args.thread_title_limit, args.thread_preview_limit),
        "topNodeProcesses": top_node_processes(),
    }


def run(args: argparse.Namespace) -> int:
    codex_home = Path(args.codex_home).expanduser().resolve()
    if not codex_home.exists():
        print(json.dumps({"ok": False, "error": "codex_home_missing", "codexHome": str(codex_home)}, ensure_ascii=False))
        return 2
    if args.action == "report":
        print(json.dumps({"ok": True, **report_state(codex_home, args)}, ensure_ascii=False, indent=2))
        return 0

    stamp = now_stamp()
    backup_root = (Path(args.backup_root).expanduser() if args.backup_root else codex_home / "backups" / f"telegram-maintenance-{stamp}").resolve()
    copied = backup_metadata(codex_home, backup_root)
    result: dict[str, Any] = {"ok": True, "action": args.action, "codexHome": str(codex_home), "backupRoot": str(backup_root), "backedUp": copied}
    if args.action == "backup":
        pass
    elif args.action == "config-prune":
        result["configPrune"] = prune_config(codex_home, backup_root, True)
    elif args.action == "worktree-archive":
        result["worktreeArchive"] = archive_worktrees(codex_home, backup_root, args.worktree_older_than_days, stamp)
    elif args.action == "log-rotate":
        result["logRotate"] = rotate_logs(codex_home, backup_root, args.rotate_logs_above_mb, stamp)
    elif args.action == "sqlite-metadata-repair":
        result["sqliteMetadataRepair"] = repair_thread_metadata_bloat(
            codex_home,
            backup_root,
            args.thread_title_limit,
            args.thread_preview_limit,
        )
    else:
        print(json.dumps({"ok": False, "error": f"unsupported_action:{args.action}"}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Codex maintenance helper for Telegram bot")
    parser.add_argument("action", choices=["report", "backup", "config-prune", "worktree-archive", "log-rotate", "sqlite-metadata-repair"])
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    parser.add_argument("--backup-root", default="")
    parser.add_argument("--worktree-older-than-days", type=int, default=7)
    parser.add_argument("--rotate-logs-above-mb", type=int, default=64)
    parser.add_argument("--thread-title-limit", type=int, default=120)
    parser.add_argument("--thread-preview-limit", type=int, default=240)
    args = parser.parse_args(argv)
    if args.thread_title_limit < 20:
        parser.error("--thread-title-limit must be at least 20")
    if args.thread_preview_limit < args.thread_title_limit:
        parser.error("--thread-preview-limit must be >= --thread-title-limit")
    return args


if __name__ == "__main__":
    raise SystemExit(run(parse_args(sys.argv[1:])))
