#!/usr/bin/env python3
"""Clean a disposable outgoing copy; unsupported formats fail closed."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import TypedDict, cast
import xml.etree.ElementTree as ET
import zipfile


INVISIBLE = re.compile("[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\U000e0000-\U000e007f]")
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".html", ".htm"}
OFFICE_EXTENSIONS = {".docx", ".xlsx", ".pptx"}


class CleanupError(RuntimeError):
    pass


class Stats(TypedDict):
    removed_count: int


class Report(TypedDict):
    actions: list[str]
    stats: Stats
    still_has_c2pa: bool
    still_has_ai_metadata: bool


def clean_text(value: str) -> tuple[str, int]:
    return INVISIBLE.subn("", value)


def run_tool(arguments: list[str]) -> str:
    if shutil.which(arguments[0]) is None:
        raise CleanupError("Install the required metadata tool: " + arguments[0])
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=45)
    if result.returncode != 0:
        raise CleanupError(arguments[0] + " metadata operation failed: exit_code=" + str(result.returncode))
    return result.stdout


def verify_binary(output: Path) -> None:
    raw: object = json.loads(run_tool(["exiftool", "-j", "-G1", "-s", str(output)]))
    if not isinstance(raw, list) or len(raw) != 1 or not isinstance(raw[0], dict):
        raise CleanupError("exiftool returned an invalid verification report")
    tags = cast(dict[str, object], raw[0])
    metadata_groups = {"EXIF", "IFD0", "IFD1", "ExifIFD", "GPS", "IPTC", "Photoshop", "Comment", "JUMBF"}
    for key in tags:
        group, _, tag = key.partition(":")
        if group in metadata_groups or group.startswith("XMP") or "c2pa" in key.lower() or "jumbf" in key.lower():
            raise CleanupError("Binary metadata remains after cleaning")
        if group == "PDF" and tag in {"Author", "Creator", "Producer", "Title", "Subject", "Keywords", "CreationDate", "ModifyDate"}:
            raise CleanupError("PDF document properties remain after cleaning")
        if group == "PNG" and tag in {"Comment", "Description", "Author", "Software", "Title", "CreationTime", "Warning"}:
            raise CleanupError("PNG text metadata remains after cleaning")


def clean_binary(source: Path, output: Path) -> list[str]:
    shutil.copyfile(source, output)
    run_tool(["exiftool", "-overwrite_original", "-all=", str(output)])
    actions = ["Removed embedded metadata with exiftool"]
    if source.suffix.lower() == ".pdf":
        descriptor, temporary_name = tempfile.mkstemp(suffix=".pdf", dir=output.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            run_tool(["qpdf", str(output), "--deterministic-id", str(temporary)])
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
        actions.append("Rewrote PDF to remove reversible metadata updates")
    verify_binary(output)
    return actions


def clean_office(source: Path, output: Path) -> tuple[list[str], int]:
    removed_count = 0
    with zipfile.ZipFile(source) as incoming:
        if sum(entry.file_size for entry in incoming.infolist()) > 1_073_741_824:
            raise CleanupError("Office container exceeds the decompressed size limit")
        removed = {entry.filename for entry in incoming.infolist()
                   if entry.filename.startswith("docProps/") or "c2pa" in entry.filename.lower() or "jumbf" in entry.filename.lower()}
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as outgoing:
            for entry in incoming.infolist():
                if entry.filename in removed or entry.is_dir():
                    continue
                content = incoming.read(entry)
                if entry.filename.endswith((".xml", ".rels")):
                    cleaned, count = clean_text(content.decode("utf-8"))
                    removed_count += count
                    content = cleaned.encode("utf-8")
                if entry.filename == "[Content_Types].xml" or entry.filename.endswith(".rels"):
                    tree = ET.fromstring(content)
                    for child in list(tree):
                        part = child.get("PartName", "").lstrip("/")
                        relationship = child.get("Type", "").lower()
                        if part in removed or relationship.endswith(("/metadata/core-properties", "/extended-properties", "/custom-properties")):
                            tree.remove(child)
                    content = ET.tostring(tree, encoding="utf-8", xml_declaration=True)
                new_entry = zipfile.ZipInfo(entry.filename, date_time=(1980, 1, 1, 0, 0, 0))
                new_entry.compress_type = zipfile.ZIP_DEFLATED
                outgoing.writestr(new_entry, content)
    return ["Removed Office document properties and ZIP metadata"], removed_count


def clean_svg(source: Path, output: Path) -> tuple[list[str], int]:
    cleaned, count = clean_text(source.read_text(encoding="utf-8"))
    tree = ET.fromstring(cleaned)
    for parent in tree.iter():
        for child in list(parent):
            if child.tag.rsplit("}", 1)[-1].lower() == "metadata":
                parent.remove(child)
    ET.ElementTree(tree).write(output, encoding="utf-8", xml_declaration=True)
    return ["Removed SVG metadata elements"], count


def clean_file(source: Path, output: Path) -> Report:
    if source.resolve() == output.resolve():
        raise CleanupError("Input and output must be different files")
    extension = source.suffix.lower()
    removed_count = 0
    if extension in {".png", ".jpg", ".jpeg", ".pdf"}:
        actions = clean_binary(source, output)
    elif extension in OFFICE_EXTENSIONS:
        actions, removed_count = clean_office(source, output)
    elif extension == ".svg":
        actions, removed_count = clean_svg(source, output)
    elif extension in TEXT_EXTENSIONS:
        text, removed_count = clean_text(source.read_text(encoding="utf-8"))
        if extension in {".html", ".htm"}:
            text = re.sub(r"<meta\b[^>]*\bname\s*=\s*['\"](?:generator|author)['\"][^>]*>", "", text, flags=re.I)
        output.write_text(text, encoding="utf-8")
        actions = ["Cleaned invisible text markers; spaces and joiners preserved"]
    else:
        raise CleanupError("Unsupported output format: " + extension)
    output.chmod(0o600)
    return {"actions": actions, "stats": {"removed_count": removed_count}, "still_has_c2pa": False, "still_has_ai_metadata": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-normalize-spaces", action="store_true", help="Accepted for compatibility; spaces are always preserved")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        report = clean_file(args.source, args.output)
    except (CleanupError, OSError, ValueError, zipfile.BadZipFile, ET.ParseError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}), file=sys.stderr)
        raise SystemExit(2) from None
    print(json.dumps(report))


if __name__ == "__main__":
    main()
