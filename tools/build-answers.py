# -*- coding: utf-8 -*-
"""Build the plugin's answer library from the HomeworkCopilot reference database.

The reference app already parsed the DOCX/PDF/XLSX answer files into its
``answer_index`` table.  Re-parsing ~500 documents would take minutes and add
python-docx as a runtime dependency, so this build step exports the parsed rows
into the plugin's own, much smaller, per-course JSONL store.

Output (all under ``workbench/data``)::

    library.json            manifest: courses, counts, source files, build time
    answers/<slug>.jsonl    one parsed question per line

A record is ``{"s": stem, "q": qtype, "o": options, "a": answer, "f": file,
"l": locator, "h": stage hint}``.  Stems are stored raw: normalisation and the
match hash are computed by ``src/answers.js`` so that build and runtime can
never disagree about text handling.

Usage:
    python tools/build-answers.py [--db PATH] [--out DIR] [--answers DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict

DEFAULT_DB = ""
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DEFAULT_ANSWERS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "answers")

# Course keys that are not real courses: the reference app once indexed a
# course-selection spreadsheet and produced 11k pseudo rows from it.
JUNK_KEY_PREFIXES = ("26秋选课数据汇总",)

# A stem that is only a document title ("0104-【国开形考作业资料】xxx") carries no
# question; those leak in from table headers.
TITLE_ONLY = re.compile(r"^[0-9]{0,4}-?【国开[^】]*】")

UNSAFE = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def slug_for(key: str, used: set[str]) -> str:
    base = UNSAFE.sub("_", key).strip(" ._")[:60] or "course"
    candidate = base
    if candidate in used:
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]
        candidate = f"{base}-{digest}"
    used.add(candidate)
    return candidate


def rel_source(path: str, answers_root: str) -> str:
    """Rewrite the reference app's absolute path to a repo-relative one."""
    if not path:
        return ""
    normalised = path.replace("\\", "/")
    marker = "/answers/"
    if marker in normalised:
        rel = normalised.split(marker, 1)[1]
        return "answers/" + rel
    name = os.path.basename(normalised)
    if name and os.path.exists(os.path.join(answers_root, name)):
        return "answers/" + name
    return normalised


def load_rows(db_path: str):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    query = (
        "select course_key, stage_hint, stem, stem_norm, qtype, options_json, "
        "answer_json, source_file, source_locator from answer_index"
    )
    for row in connection.execute(query):
        yield dict(row)
    connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--answers", default=DEFAULT_ANSWERS)
    args = parser.parse_args()

    if not args.db or not os.path.exists(args.db):
        parser.error(
            "--db 需要指向参考软件的 data/homework.db，例如：\n"
            '  python tools/build-answers.py --db "C:\\...\\HomeworkCopilot\\data\\homework.db" --out "D:\\ouchn-data"'
        )

    answers_dir = os.path.join(args.out, "answers")
    os.makedirs(answers_dir, exist_ok=True)

    courses: dict[str, dict] = {}
    skipped = Counter()
    total = 0
    written = 0
    handles: dict[str, object] = {}
    used_slugs: set[str] = set()

    try:
        for row in load_rows(args.db):
            total += 1
            key = (row.get("course_key") or "").strip()
            qtype = (row.get("qtype") or "unknown").strip()
            stem = (row.get("stem") or "").strip()

            if not key:
                skipped["no course"] += 1
                continue
            if key.startswith(JUNK_KEY_PREFIXES):
                skipped["junk key"] += 1
                continue
            if qtype == "unknown":
                skipped["unknown type"] += 1
                continue
            if not stem or len(stem) < 4:
                skipped["short stem"] += 1
                continue
            if TITLE_ONLY.match(stem) and len(stem) < 60:
                skipped["title only"] += 1
                continue

            try:
                options = json.loads(row.get("options_json") or "{}")
            except json.JSONDecodeError:
                options = {}
            try:
                answer = json.loads(row.get("answer_json") or "[]")
            except json.JSONDecodeError:
                answer = []
            if not isinstance(answer, list):
                answer = [answer]
            answer = [str(item) for item in answer if str(item).strip()]
            if not answer:
                skipped["no answer"] += 1
                continue

            course = courses.get(key)
            if course is None:
                slug = slug_for(key, used_slugs)
                course = {
                    "key": key,
                    "slug": slug,
                    "count": 0,
                    "stages": Counter(),
                    "qtypes": Counter(),
                    "files": set(),
                }
                courses[key] = course

            path = os.path.join(answers_dir, course["slug"] + ".jsonl")
            handle = handles.get(course["slug"])
            if handle is None:
                handle = open(path, "w", encoding="utf-8", newline="\n")
                handles[course["slug"]] = handle

            record = {
                "s": stem,
                "q": qtype,
                "a": answer,
            }
            if options:
                record["o"] = options
            hint = (row.get("stage_hint") or "").strip()
            if hint:
                record["h"] = hint
            file_rel = rel_source(row.get("source_file") or "", args.answers)
            if file_rel:
                record["f"] = file_rel
            locator = (row.get("source_locator") or "").strip()
            if locator:
                record["l"] = locator

            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            written += 1
            course["count"] += 1
            course["stages"][hint or "ANY"] += 1
            course["qtypes"][qtype] += 1
            if file_rel:
                course["files"].add(file_rel)
    finally:
        for handle in handles.values():
            handle.close()

    manifest = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": os.path.basename(args.db),
        "totalRows": total,
        "written": written,
        "skipped": dict(skipped),
        "courses": [
            {
                "key": course["key"],
                "slug": course["slug"],
                "count": course["count"],
                "stages": dict(course["stages"]),
                "qtypes": dict(course["qtypes"]),
                "files": sorted(course["files"]),
            }
            for course in sorted(courses.values(), key=lambda item: item["key"])
        ],
    }
    with open(os.path.join(args.out, "library.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=1)

    size = sum(
        os.path.getsize(os.path.join(answers_dir, name))
        for name in os.listdir(answers_dir)
        if name.endswith(".jsonl")
    )
    print(f"rows read   : {total}")
    print(f"rows written: {written}")
    print(f"courses     : {len(courses)}")
    print(f"data size   : {size / 1024 / 1024:.1f} MiB")
    for reason, count in skipped.most_common():
        print(f"  skipped {reason}: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
