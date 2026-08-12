#!/usr/bin/env python3
"""Extract a small, labeled CASIA-OLHWDB WPTT sample set for local benchmarking.

The source archive and generated images stay outside the repository. This helper
only accepts an explicit local archive and writes PNGs plus a benchmark manifest
to an explicit output directory.
"""

from __future__ import annotations

import argparse
import json
import struct
import zipfile
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw


def read_u16(data: bytes, offset: int) -> tuple[int, int]:
    return struct.unpack_from("<H", data, offset)[0], offset + 2


def read_i32(data: bytes, offset: int) -> tuple[int, int]:
    return struct.unpack_from("<i", data, offset)[0], offset + 4


def decode_tag(raw: bytes, code_length: int, char_count: int) -> str | None:
    """Decode CASIA's fixed-width GB/ASCII tags; None means an abnormal line."""

    if code_length != 2 or len(raw) != code_length * char_count:
        return None

    result: list[str] = []
    for index in range(char_count):
        code = raw[index * code_length : (index + 1) * code_length]
        if code == b"\xff\xff":
            return None
        if code[1] == 0 and code[0] != 0:
            result.append(chr(code[0]))
            continue
        try:
            result.append(code.decode("gb18030"))
        except UnicodeDecodeError:
            return None

    text = "".join(result).replace("\x00", "")
    return text if text.strip() else None


def parse_wptt(data: bytes) -> list[tuple[str, list[list[tuple[float, float]]]]]:
    header_size, offset = read_i32(data, 0)
    if header_size < 54 or header_size > len(data):
        raise ValueError("invalid WPTT header size")
    if data[offset : offset + 4] != b"WPTT":
        raise ValueError("not a WPTT file")
    offset += 8
    offset = 4 + 8 + (header_size - 54)
    code_type = data[offset : offset + 20].split(b"\0", 1)[0].decode("ascii", "ignore")
    offset += 20
    code_length, offset = read_u16(data, offset)
    offset += 20  # data type
    if code_type != "GB":
        raise ValueError(f"unsupported WPTT code type: {code_type!r}")

    _sample_length, offset = read_i32(data, offset)
    _page_index, offset = read_i32(data, offset)
    stroke_count, offset = read_i32(data, offset)
    strokes: list[list[tuple[float, float]]] = []
    for _ in range(stroke_count):
        point_count, offset = read_u16(data, offset)
        points: list[tuple[float, float]] = []
        for _ in range(point_count):
            x, offset = read_u16(data, offset)
            y, offset = read_u16(data, offset)
            points.append((x / 10.0, -y / 10.0))
        strokes.append(points)

    line_count, offset = read_u16(data, offset)
    lines: list[tuple[str, list[list[tuple[float, float]]]]] = []
    for _ in range(line_count):
        line_stroke_count, offset = read_u16(data, offset)
        indices = []
        for _ in range(line_stroke_count):
            stroke_index, offset = read_u16(data, offset)
            if stroke_index >= len(strokes):
                raise ValueError("WPTT line references an absent stroke")
            indices.append(stroke_index)
        char_count, offset = read_u16(data, offset)
        label_end = offset + code_length * char_count
        label = decode_tag(data[offset:label_end], code_length, char_count)
        offset = label_end
        if label is None:
            continue
        lines.append((label, [strokes[index] for index in indices]))
    return lines


def render_line(
    strokes: Iterable[Iterable[tuple[float, float]]],
    output: Path,
    scale: float = 3.0,
    padding: int = 24,
) -> None:
    points = [point for stroke in strokes for point in stroke]
    if not points:
        raise ValueError("cannot render an empty line")
    min_x = min(point[0] for point in points)
    max_x = max(point[0] for point in points)
    min_y = min(point[1] for point in points)
    max_y = max(point[1] for point in points)
    width = max(1, round((max_x - min_x) * scale) + padding * 2)
    height = max(1, round((max_y - min_y) * scale) + padding * 2)
    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    line_width = max(2, round(scale * 0.9))
    for stroke in strokes:
        rendered = [
            (round((x - min_x) * scale) + padding, round((max_y - y) * scale) + padding)
            for x, y in stroke
        ]
        if len(rendered) == 1:
            draw.ellipse(
                (
                    rendered[0][0] - line_width,
                    rendered[0][1] - line_width,
                    rendered[0][0] + line_width,
                    rendered[0][1] + line_width,
                ),
                fill=0,
            )
        elif rendered:
            draw.line(rendered, fill=0, width=line_width, joint="curve")
    image.save(output, format="PNG", optimize=True)


def parse_writer_list(value: str) -> list[str]:
    writers = [item.strip() for item in value.split(",") if item.strip()]
    if not writers or any(not item.isdigit() for item in writers):
        raise argparse.ArgumentTypeError("--writers must be a comma-separated list of numeric writer IDs")
    return writers


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", dest="archive", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--writers", type=parse_writer_list, required=True)
    parser.add_argument("--page", default="P14", help="page suffix, for example P14")
    parser.add_argument("--lines-per-writer", type=int, default=1)
    parser.add_argument("--scale", type=float, default=3.0, help="PNG pixels per source coordinate unit")
    args = parser.parse_args()
    if args.lines_per_writer < 1 or args.lines_per_writer > 3:
        parser.error("--lines-per-writer must be between 1 and 3")
    if not 0.5 <= args.scale <= 6:
        parser.error("--scale must be between 0.5 and 6")
    if not args.archive.is_file():
        parser.error(f"archive does not exist: {args.archive}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    cases: list[dict[str, object]] = []
    with zipfile.ZipFile(args.archive) as archive:
        members = {Path(info.filename).name: info for info in archive.infolist()}
        for writer in args.writers:
            member_name = f"{writer}-{args.page}.wptt"
            if member_name not in members:
                raise SystemExit(f"archive does not contain {member_name}")
            lines = parse_wptt(archive.read(members[member_name]))
            for line_index, (expected, strokes) in enumerate(lines[: args.lines_per_writer]):
                sample_id = f"casia-olhwdb2.2-{writer.lower()}-{args.page.lower()}-line-{line_index + 1:02d}"
                image_name = f"{sample_id}.png"
                render_line(strokes, args.output_dir / image_name, scale=args.scale)
                cases.append(
                    {
                        "id": sample_id,
                        "expected": expected,
                        "imagePath": image_name,
                        "metadata": {
                            "writer": f"public-casia-{writer}",
                            "inputMode": "stylus-online",
                            "orientation": "landscape-line",
                            "textType": "text-line",
                        },
                    }
                )

    if not cases:
        raise SystemExit("no labeled lines were extracted")
    (args.output_dir / "manifest.json").write_text(
        json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"samples": len(cases), "outputDir": str(args.output_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
