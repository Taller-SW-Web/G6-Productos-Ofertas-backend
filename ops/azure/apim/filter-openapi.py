#!/usr/bin/env python3
"""Build an APIM OpenAPI document from Gateway's explicit route registries."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import yaml

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head"}
OPERATION_ID = re.compile(r"operationId\s*:\s*['\"]([A-Za-z0-9_.-]+)['\"]")
LEGACY_UNCONTRACTED = {
    "obtenerDefinicionPrecioProductoAdministracion",
    "obtenerDefinicionPrecioSkuAdministracion",
}


def read_registry(path: Path) -> list[str]:
    contents = path.read_text(encoding="utf-8")
    operation_ids = OPERATION_ID.findall(contents)
    if not operation_ids:
        raise ValueError(f"No se encontraron operationId en {path}")
    if len(operation_ids) != len(set(operation_ids)):
        raise ValueError(f"operationId duplicado en {path}")
    return operation_ids


def filter_spec(
    source: dict,
    gateway_ids: list[str],
    g5_ids: list[str],
    enable_g5: bool,
    docs_sha: str,
    gateway_sha: str,
) -> tuple[dict, dict]:
    paths = source.get("paths")
    if not isinstance(paths, dict):
        raise ValueError("OpenAPI no contiene paths")

    operation_index: dict[str, tuple[str, str, dict]] = {}
    private_ids: list[str] = []
    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, dict):
                continue
            operation_id = operation.get("operationId")
            if not operation_id or operation_id in operation_index:
                raise ValueError(f"operationId ausente o duplicado: {operation_id}")
            operation_index[operation_id] = (path, method, operation)
            if operation.get("x-internal") is True:
                private_ids.append(operation_id)

    if len(private_ids) != 5:
        raise ValueError(f"Se esperaban cinco operaciones internas y hay {len(private_ids)}")
    if set(gateway_ids) & set(private_ids) or set(g5_ids) & set(private_ids):
        raise ValueError("Una ruta interna aparece en el registro público del Gateway")

    uncontracted = set(gateway_ids) & LEGACY_UNCONTRACTED
    enabled_ids = (set(gateway_ids) - LEGACY_UNCONTRACTED) | (
        set(g5_ids) if enable_g5 else set()
    )
    missing = enabled_ids - operation_index.keys()
    if missing:
        raise ValueError(f"Rutas registradas sin operación OpenAPI: {sorted(missing)}")
    if set(gateway_ids) & set(g5_ids):
        raise ValueError("Las rutas G5 deben ser exclusivas del registro opt-in")

    selected_paths: dict[str, dict] = {}
    operations: list[dict] = []
    for operation_id in sorted(enabled_ids):
        path, method, operation = operation_index[operation_id]
        path_item = source["paths"][path]
        selected = selected_paths.setdefault(
            path,
            {key: value for key, value in path_item.items() if key not in HTTP_METHODS},
        )
        selected[method] = operation
        operations.append(
            {
                "operationId": operation_id,
                "method": method.upper(),
                "path": path,
                "secured": bool(
                    operation["security"]
                    if "security" in operation
                    else source.get("security", [])
                ),
                "g5OptIn": operation_id in g5_ids,
            }
        )

    filtered = dict(source)
    filtered["paths"] = selected_paths
    filtered["servers"] = [{"url": "/api/v1"}]
    filtered["x-apim-filter"] = {
        "docsSha": docs_sha,
        "gatewaySha": gateway_sha,
        "g5EnabledByDefault": False,
        "privateOperationCount": len(private_ids),
    }
    manifest = {
        "docsSha": docs_sha,
        "gatewaySha": gateway_sha,
        "privateOperationIds": sorted(private_ids),
        "excludedUncontractedLegacyOperationIds": sorted(uncontracted),
        "g5EnabledByDefault": False,
        "operations": operations,
    }
    return filtered, manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--openapi", type=Path, required=True)
    parser.add_argument("--gateway-routes", type=Path, required=True)
    parser.add_argument("--g5-routes", type=Path, required=True)
    parser.add_argument("--docs-sha", required=True)
    parser.add_argument("--gateway-sha", required=True)
    parser.add_argument("--enable-g5", action="store_true", help="Opt-in explícito, desactivado por defecto")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()

    source = yaml.safe_load(args.openapi.read_text(encoding="utf-8"))
    filtered, manifest = filter_spec(
        source,
        read_registry(args.gateway_routes),
        read_registry(args.g5_routes),
        args.enable_g5,
        args.docs_sha,
        args.gateway_sha,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(filtered, indent=2) + "\n", encoding="utf-8")
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
