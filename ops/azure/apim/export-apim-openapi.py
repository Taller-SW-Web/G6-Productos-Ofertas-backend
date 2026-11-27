#!/usr/bin/env python3
"""Normaliza el OpenAPI 3.1.0 filtrado de G6 a OpenAPI 3.0.3 compatible con Azure APIM."""

import argparse
import copy
import json
from pathlib import Path


def normalize_oas_for_apim(spec: dict) -> dict:
    out = copy.deepcopy(spec)

    def walk(node: object) -> None:
        if isinstance(node, dict):
            if (
                "exclusiveMinimum" in node
                and isinstance(node["exclusiveMinimum"], (int, float))
                and not isinstance(node["exclusiveMinimum"], bool)
            ):
                node["minimum"] = node["exclusiveMinimum"]
                node["exclusiveMinimum"] = True
            if (
                "exclusiveMaximum" in node
                and isinstance(node["exclusiveMaximum"], (int, float))
                and not isinstance(node["exclusiveMaximum"], bool)
            ):
                node["maximum"] = node["exclusiveMaximum"]
                node["exclusiveMaximum"] = True
            if "type" in node and isinstance(node["type"], list):
                non_null = [t for t in node["type"] if t != "null"]
                if "null" in node["type"]:
                    node["nullable"] = True
                if len(non_null) == 1:
                    node["type"] = non_null[0]
                elif len(non_null) > 1:
                    del node["type"]
                    node["anyOf"] = [{"type": t} for t in non_null]
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(out)
    if isinstance(out.get("info"), dict):
        out["info"].pop("summary", None)
    if str(out.get("openapi", "")).startswith("3.1"):
        out["openapi"] = "3.0.3"
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        type=Path,
        default=Path(__file__).resolve().parent / "openapi" / "gateway-filtered.compact.json",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads(args.input.read_text(encoding="utf-8"))
    normalized = normalize_oas_for_apim(spec)
    args.output.write_text(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Exportado OpenAPI 3.0.3 compatible con APIM: {args.output}")


if __name__ == "__main__":
    main()
