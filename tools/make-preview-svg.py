# -*- coding: utf-8 -*-
"""Turn a console screenshot into docs/preview.svg (single-image plugin detail).

The plugin detail page renders one image, so the preview embeds a real screenshot
of the console as a JPEG data URL instead of a hand-drawn mock that would drift
from the shipped layout.

Usage:
    python tools/make-preview-svg.py <screenshot.png> [--width 1280] [--out docs/preview.svg]
"""
import argparse
import base64
import io
import os
import sys

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "preview.svg"))
    args = parser.parse_args()

    image = Image.open(args.source).convert("RGB")
    scale = args.width / image.width
    height = round(image.height * scale)
    image = image.resize((args.width, height), Image.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=74, optimize=True, progressive=True)
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{args.width}" height="{height}" '
        f'viewBox="0 0 {args.width} {height}" role="img" '
        f'aria-label="国开作业执行台：左栏真实课程，中栏任务与逐题明细，右栏平台实时画面与运行数据，底部 agent 执行时间线">'
        f'<rect width="{args.width}" height="{height}" fill="#17181c"/>'
        f'<image width="{args.width}" height="{height}" href="data:image/jpeg;base64,{payload}"/>'
        f'</svg>\n'
    )
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(svg)
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KiB, {args.width}x{height})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
