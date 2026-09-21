#!/usr/bin/env python3
"""Run the documented 0819 processing stages in order.

The runner retains the existing builders as the canonical implementation.  It
adds one explicit handoff entry point for validating inputs, generating the
component-level CSV/HTML outputs, and building the episode-review viewer.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

from validate_inputs import DEFAULT_LOG_ROOT, DEFAULT_MAPPED_ROOT, normalized_task_ids, validate


PIPELINE_ROOT = Path(__file__).resolve().parent
BUILDERS_ROOT = PIPELINE_ROOT / "builders"
# `build_episode_review.py` imports the component builder by its historical
# top-level module name. Keep that import valid even when this runner is called
# from outside the 0819 directory.
if str(BUILDERS_ROOT) not in sys.path:
    sys.path.insert(0, str(BUILDERS_ROOT))


def load_module(name: str, path: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def path_arguments(log_root: Path, mapped_root: Path, output_root: Path, tasks: list[str]) -> list[str]:
    arguments = [
        "--log-root", str(log_root),
        "--mapped-root", str(mapped_root),
        "--output-root", str(output_root),
    ]
    if tasks:
        arguments.extend(["--tasks", *tasks])
    return arguments


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate and rebuild the 0819 gaze-to-episode pipeline.")
    parser.add_argument("--log-root", type=Path, default=DEFAULT_LOG_ROOT)
    parser.add_argument("--mapped-root", type=Path, default=DEFAULT_MAPPED_ROOT)
    parser.add_argument("--output-root", type=Path,
                        help="Parent directory for component_state_review and episode_review. Defaults to processing_pipeline/derived.")
    parser.add_argument("--tasks", nargs="*", help="Task IDs; omit for all numeric recorder folders")
    parser.add_argument("--skip-validation", action="store_true")
    parser.add_argument("--component-only", action="store_true")
    parser.add_argument("--episode-only", action="store_true")
    args = parser.parse_args(argv)
    if args.component_only and args.episode_only:
        parser.error("Choose at most one of --component-only and --episode-only.")

    log_root = args.log_root.expanduser().resolve()
    mapped_root = args.mapped_root.expanduser().resolve()
    tasks = normalized_task_ids(args.tasks, log_root)
    if not args.skip_validation:
        report = validate(log_root, mapped_root, tasks)
        if report["failed_count"]:
            print(f"Input validation failed for {report['failed_count']} task(s). No outputs were rebuilt.")
            return 1

    if args.output_root:
        output_parent = args.output_root.expanduser().resolve()
        component_output = output_parent / "component_state_review"
        episode_output = output_parent / "episode_review"
    else:
        component_output = PIPELINE_ROOT / "derived" / "component_state_review"
        episode_output = PIPELINE_ROOT / "derived" / "episode_review"

    if not args.episode_only:
        component = load_module("component_builder", BUILDERS_ROOT / "build_component_state_review.py")
        component.main(path_arguments(log_root, mapped_root, component_output, tasks))
    if not args.component_only:
        episode = load_module("episode_builder", BUILDERS_ROOT / "build_episode_review.py")
        episode.main(path_arguments(log_root, mapped_root, episode_output, tasks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
