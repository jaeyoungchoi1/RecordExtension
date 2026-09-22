#!/usr/bin/env python3
"""Rebuild compact standalone task HTML from existing local analysis JSON files."""
import argparse
import json
from pathlib import Path

from jy_build_common_review import PIPELINE, write_html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-root", type=Path, default=PIPELINE / "jy_derived" / "common_review")
    parser.add_argument("--tasks", nargs="+", default=[str(i) for i in range(1, 32)])
    parser.add_argument("--html-image-width", type=int, default=1000)
    parser.add_argument("--html-image-quality", type=int, default=58)
    args = parser.parse_args()
    root = args.report_root.expanduser().resolve()
    for task in sorted({f"{int(t):02d}" for t in args.tasks}, key=int):
        source = root / "data" / f"task{task}" / "analysis.json"
        if not source.is_file():
            print(f"task{task}: skipped (analysis.json missing)")
            continue
        print(f"task{task}: reading local audit ...", flush=True)
        payload = json.loads(source.read_text(encoding="utf-8"))
        write_html(root / f"task{task}.html", payload, args.html_image_width, args.html_image_quality)
        size = (root / f"task{task}.html").stat().st_size / 1024 / 1024
        print(f"task{task}: {size:.1f} MiB standalone HTML", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
