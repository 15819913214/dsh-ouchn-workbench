# -*- coding: utf-8 -*-
"""Write a small sample answer bank for the public repository.

The full bank is personal study material and never enters the repository. This
tool copies the manifest entries of a few well-covered courses into
``data/library.sample.json``; the corresponding ``data/answers/<slug>.jsonl``
files are the only answer files the repository ships.

Usage:
    python tools/make-sample.py [--courses 管理学基础 市场营销学 形势与政策]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")

DEFAULT_COURSES = ["管理学基础", "市场营销学", "形势与政策"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--courses", nargs="*", default=DEFAULT_COURSES)
    parser.add_argument("--source", default=os.path.join(DATA, "library.json"))
    parser.add_argument("--out", default=os.path.join(DATA, "library.sample.json"))
    args = parser.parse_args()

    if not os.path.exists(args.source):
        print(f"missing {args.source}; run tools/build-answers.py first", file=sys.stderr)
        return 1

    with open(args.source, encoding="utf-8") as handle:
        manifest = json.load(handle)

    by_key = {course["key"]: course for course in manifest.get("courses", [])}
    picked = []
    for name in args.courses:
        course = by_key.get(name)
        if not course:
            print(f"skip {name}: not in the manifest", file=sys.stderr)
            continue
        source_file = os.path.join(DATA, "answers", course["slug"] + ".jsonl")
        if not os.path.exists(source_file):
            print(f"skip {name}: missing {source_file}", file=sys.stderr)
            continue
        picked.append(course)
        target = os.path.join(HERE, "..", "data", "answers", course["slug"] + ".jsonl")
        if os.path.abspath(source_file) != os.path.abspath(target):
            shutil.copyfile(source_file, target)

    if not picked:
        print("no course picked", file=sys.stderr)
        return 1

    merged = {
        "builtAt": manifest.get("builtAt"),
        "source": "sample",
        "totalRows": sum(course["count"] for course in picked),
        "written": sum(course["count"] for course in picked),
        "skipped": {"sample only": manifest.get("written", 0) - sum(course["count"] for course in picked)},
        "courses": picked,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, ensure_ascii=False, indent=1)

    print(f"wrote {args.out}")
    for course in picked:
        print(f"  {course['key']}: {course['count']} questions ({course['slug']}.jsonl)")
    print(f"total: {merged['written']} questions, {len(picked)} courses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
