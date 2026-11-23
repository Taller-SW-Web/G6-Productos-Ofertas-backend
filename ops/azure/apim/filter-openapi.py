#!/usr/bin/env python3
"""Build an APIM OpenAPI document from Gateway's explicit route registries."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import yaml

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head"}
ROUTE_ENTRY = re.compile(
    r"\{\s*method:\s*['\"]([A-Z]+)['\"]\s*,\s*"
    r"path:\s*['\"]([^'\"]+)['\"]\s*,\s*"
    r"operationId:\s*['\"]([A-Za-z0-9_.-]+)['\"]",
    re.S,
)
LEGACY_UNCONTRACTED = {
    "obtenerDefinicionPrecioProductoAdministracion",
    "obtenerDefinicionPrecioSkuAdministracion",
}


def read_registry(path: Path) -> list[dict[str, str]]:
    contents = path.read_text(encoding="utf-8")
    entries = [
        {"method": method, "path": route_path, "operationId": operation_id}
        for method, route_path, operation_id in ROUTE_ENTRY.findall(contents)
    ]
    operation_ids = [entry["operationId"] for entry in entries]
    if not entries:
        raise ValueError(f"No se encontraron operationId en {path}")
    if len(operation_ids) != len(set(operation_ids)):
        raise ValueError(f"operationId duplicado en {path}")
    return entries


def normalize_apim_operation_id(operation_id: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", operation_id.lower()).strip("-")[:76]
    if not normalized or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", normalized):
        raise ValueError(f"operationId incompatible con APIM: {operation_id!r}")
    return normalized


def canonical_sha256(value: object) -> str:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def operation_records(spec: dict) -> list[dict]:
    records = []
    for path, path_item in spec.get("paths", {}).items():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, dict):
                continue
            records.append(
                {
                    "operationId": operation.get("operationId"),
                    "method": method.upper(),
                    "path": path,
                    "secured": bool(
                        operation["security"]
                        if "security" in operation
                        else spec.get("security", [])
                    ),
                }
            )
    return sorted(records, key=lambda item: (item["operationId"] or "", item["method"], item["path"]))


def validate_artifact_pair(filtered: dict, manifest: dict) -> None:
    expected = [
        {
            "operationId": operation["operationId"],
            "method": operation["method"],
            "path": operation["path"],
            "secured": operation["secured"],
        }
        for operation in manifest.get("operations", [])
    ]
    if operation_records(filtered) != sorted(
        expected, key=lambda item: (item["operationId"], item["method"], item["path"])
    ):
        raise ValueError("El manifiesto no corresponde al conjunto método/ruta/operationId del OpenAPI filtrado")
    if canonical_sha256(filtered) != manifest.get("filteredOpenApiCanonicalSha256"):
        raise ValueError("OpenAPI filtrado distinto del SHA declarado por el manifiesto")
    operation_set_hash = canonical_sha256(operation_records(filtered))
    if operation_set_hash != manifest.get("operationSetSha256"):
        raise ValueError("operationSetSha256 no corresponde al conjunto importado")
    if filtered.get("x-apim-filter", {}).get("operationSetSha256") != operation_set_hash:
        raise ValueError("El OpenAPI filtrado declara otro conjunto de operaciones")
    ids = [operation["apimOperationId"] for operation in manifest["operations"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Colisión de apimOperationId en el manifiesto")
    for operation in manifest["operations"]:
        if operation["apimOperationId"] != normalize_apim_operation_id(operation["operationId"]):
            raise ValueError(f"apimOperationId no corresponde a {operation['operationId']}")


def filter_spec(
    source: dict,
    gateway_routes: list[dict[str, str]],
    g5_routes: list[dict[str, str]],
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
    gateway_ids = {route["operationId"] for route in gateway_routes}
    g5_ids = {route["operationId"] for route in g5_routes}
    if gateway_ids & set(private_ids) or g5_ids & set(private_ids):
        raise ValueError("Una ruta interna aparece en el registro público del Gateway")

    uncontracted = gateway_ids & LEGACY_UNCONTRACTED
    selected_ids = (gateway_ids - LEGACY_UNCONTRACTED) | (g5_ids if enable_g5 else set())
    route_index = {route["operationId"]: route for route in gateway_routes + g5_routes}
    enabled_ids = selected_ids
    missing = enabled_ids - operation_index.keys()
    if missing:
        raise ValueError(f"Rutas registradas sin operación OpenAPI: {sorted(missing)}")
    if gateway_ids & g5_ids:
        raise ValueError("Las rutas G5 deben ser exclusivas del registro opt-in")

    server_url = source.get("servers", [{}])[0].get("url", "")
    server_path = re.sub(r"https?://[^/]+", "", server_url).rstrip("/")
    for operation_id in gateway_ids | g5_ids:
        route = route_index[operation_id]
        operation = operation_index.get(operation_id)
        if operation is None:
            if operation_id in LEGACY_UNCONTRACTED:
                continue
            raise ValueError(f"operationId no documentado: {operation_id}")
        path, method, _ = operation
        expected_route = f"{server_path}{path}" if server_path else path
        if route["method"] != method.upper() or route["path"] != expected_route:
            raise ValueError(
                f"Método/ruta de Gateway no corresponde al OpenAPI para {operation_id}: "
                f"{route['method']} {route['path']} != {method.upper()} {expected_route}"
            )

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
                "apimOperationId": normalize_apim_operation_id(operation_id),
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
    operation_set_hash = canonical_sha256(operation_records(filtered))
    filtered["x-apim-filter"]["operationSetSha256"] = operation_set_hash
    manifest = {
        "docsSha": docs_sha,
        "gatewaySha": gateway_sha,
        "privateOperationIds": sorted(private_ids),
        "excludedUncontractedLegacyOperationIds": sorted(uncontracted),
        "g5EnabledByDefault": False,
        "operations": operations,
        "operationSetSha256": operation_set_hash,
        "filteredOpenApiCanonicalSha256": canonical_sha256(filtered),
    }
    validate_artifact_pair(filtered, manifest)
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
    output_text = json.dumps(filtered, indent=2) + "\n"
    args.output.write_text(output_text, encoding="utf-8")
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
