#!/usr/bin/env python3
"""Expose already screen-mapped gaze CSVs under the pipeline's filename contract.

Some bundles store valid mapped gaze as ``task1_gaze.csv`` through
``task31_gaze.csv`` in an ``out/`` folder. The 0819 builders use historical
names such as ``task01_mapped_gaze.csv``. This helper creates symlinks by
default, so it never duplicates or changes the source recordings. It does
*not* perform eye-tracker-to-screen registration.
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
from pathlib import Path

from validate_inputs import REQUIRED_GAZE_COLUMNS


SOURCE_PATTERN = re.compile(r"task(\d+)_gaze\.csv$")


def source_files(source_root: Path) -> list[tuple[int, Path]]:
    files: list[tuple[int, Path]] = []
    for path in source_root.glob("task*_gaze.csv"):
        match = SOURCE_PATTERN.fullmatch(path.name)
        if match:
            files.append((int(match.group(1)), path))
    return sorted(files)


def validate_columns(path: Path) -> None:
    with path.open(newline="") as handle:
        columns = set(csv.DictReader(handle).fieldnames or [])
    missing = sorted(REQUIRED_GAZE_COLUMNS - columns)
    if missing:
        raise ValueError(f"{path.name}: missing required columns: {', '.join(missing)}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Normalize already screen-mapped taskN_gaze.csv files for the 0819 pipeline."
    )
    parser.add_argument("--source-root", type=Path, required=True,
                        help="Folder containing task1_gaze.csv, task2_gaze.csv, etc.")
    parser.add_argument("--mapped-root", type=Path, required=True,
                        help="Destination folder for taskNN_mapped_gaze.csv links or copies.")
    parser.add_argument("--copy", action="store_true",
                        help="Copy CSVs instead of creating symlinks (uses additional disk space).")
    args = parser.parse_args(argv)

    source_root = args.source_root.expanduser().resolve()
    mapped_root = args.mapped_root.expanduser().resolve()
    if not source_root.is_dir():
        parser.error(f"Source folder does not exist: {source_root}")
    files = source_files(source_root)
    if not files:
        parser.error(f"No taskN_gaze.csv files found in {source_root}")
    for _, source in files:
        validate_columns(source)

    mapped_root.mkdir(parents=True, exist_ok=True)
    for task_number, source in files:
        target = mapped_root / f"task{task_number:02d}_mapped_gaze.csv"
        if target.exists() or target.is_symlink():
            raise FileExistsError(f"Destination already exists; refusing to overwrite: {target}")
        if args.copy:
            shutil.copy2(source, target)
        else:
            target.symlink_to(source.resolve())

    mode = "copies" if args.copy else "symlinks"
    print(f"Created {len(files)} {mode} in {mapped_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
