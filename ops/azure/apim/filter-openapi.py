#!/usr/bin/env python3
"""Build an APIM OpenAPI document and enriched security manifest from Gateway registries."""

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
KNOWN_SECURITY_SCHEMES = {"userBearer", "serviceBearer"}
KNOWN_RATE_PROFILES = {
    "commercial_read",
    "admin_read",
    "business_write",
    "multipart_import",
    "expensive_export",
    "g5_protected",
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


def _extract_security_schemes(operation: dict, source: dict) -> list[str]:
    raw = operation["security"] if "security" in operation else source.get("security", [])
    schemes: list[str] = []
    if not isinstance(raw, list):
        raise ValueError(f"security inválido en {operation.get('operationId')}")
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError(f"Entrada security inválida en {operation.get('operationId')}")
        for scheme_name in item.keys():
            if scheme_name not in KNOWN_SECURITY_SCHEMES:
                raise ValueError(
                    f"Esquema de seguridad desconocido {scheme_name!r} en {operation.get('operationId')}"
                )
            if scheme_name not in schemes:
                schemes.append(scheme_name)
    return sorted(schemes)


def _as_string_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    raise ValueError(f"Se esperaba cadena o lista de cadenas, recibido: {value!r}")


def _derive_rate_profile(
    operation_id: str,
    method: str,
    path: str,
    operation: dict,
    roles: list[str],
    is_g5: bool,
) -> str:
    if is_g5:
        return "g5_protected"
    request_content = operation.get("requestBody", {}).get("content", {})
    if isinstance(request_content, dict) and "multipart/form-data" in request_content:
        return "multipart_import"
    responses = operation.get("responses", {})
    has_csv_or_binary = any(
        isinstance(resp, dict)
        and isinstance(resp.get("content"), dict)
        and any(
            mt in resp["content"]
            for mt in ("text/csv", "application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        )
        for resp in responses.values()
    )
    lowered_id = operation_id.lower()
    if has_csv_or_binary or "exportar" in lowered_id or "reporte" in lowered_id:
        return "expensive_export"
    if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        return "business_write"
    if "/administracion" in path or "GESTOR_COMERCIAL" in roles:
        return "admin_read"
    return "commercial_read"


def _derive_exposure_profile(
    identity_type: str,
    path: str,
    roles: list[str],
    is_g5: bool,
) -> str:
    if is_g5:
        return "g5_protected"
    if identity_type == "public":
        return "public_read"
    if identity_type == "m2m":
        return "m2m_partner"
    if "/administracion" in path or "GESTOR_COMERCIAL" in roles:
        return "admin"
    return "commercial"


def extract_operation_security_metadata(
    operation_id: str,
    method: str,
    path: str,
    operation: dict,
    source: dict,
    is_g5: bool,
) -> dict:
    auth_schemes = _extract_security_schemes(operation, source)
    if not auth_schemes:
        identity_type = "public"
    elif "serviceBearer" in auth_schemes:
        identity_type = "m2m"
    else:
        identity_type = "human"

    scopes = _as_string_list(operation.get("x-required-scope"))
    roles = _as_string_list(operation.get("x-required-role"))
    allowed_clients = _as_string_list(operation.get("x-allowed-client-ids"))
    audience = operation.get("x-service-audience")
    if audience is not None and not isinstance(audience, str):
        raise ValueError(f"x-service-audience inválido en {operation_id}")
    audience = audience.strip() if isinstance(audience, str) and audience.strip() else None

    introspection_mode = operation.get("x-auth-validation")
    if introspection_mode is not None and introspection_mode not in {"introspection", "jwks"}:
        raise ValueError(f"x-auth-validation desconocido en {operation_id}: {introspection_mode!r}")
    introspection_required = introspection_mode == "introspection"

    # APIM-C01: bloquear publicación si falta metadata contractual obligatoria para M2M.
    if identity_type == "m2m":
        if not audience:
            raise ValueError(f"Falta x-service-audience obligatorio para operación M2M: {operation_id}")
        if not scopes:
            raise ValueError(f"Falta x-required-scope obligatorio para operación M2M: {operation_id}")

    audience_required = identity_type == "m2m" or audience is not None
    rate_profile = _derive_rate_profile(operation_id, method, path, operation, roles, is_g5)
    exposure_profile = _derive_exposure_profile(identity_type, path, roles, is_g5)

    return {
        "operationId": operation_id,
        "apimOperationId": normalize_apim_operation_id(operation_id),
        "method": method.upper(),
        "path": path,
        "secured": bool(auth_schemes),
        "authSchemes": auth_schemes,
        "identityType": identity_type,
        "issuerRequired": bool(auth_schemes),
        "audienceRequired": audience_required,
        "audience": audience,
        "scopes": sorted(scopes),
        "roles": sorted(roles),
        "allowedClients": sorted(allowed_clients),
        "introspectionRequired": introspection_required,
        "exposureProfile": exposure_profile,
        "rateProfile": rate_profile,
        "environmentEnabled": True,
        "g5OptIn": is_g5,
    }


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
        if operation.get("rateProfile") not in KNOWN_RATE_PROFILES:
            raise ValueError(f"rateProfile inválido en {operation['operationId']}")
        if operation.get("identityType") not in {"public", "human", "m2m"}:
            raise ValueError(f"identityType inválido en {operation['operationId']}")


def filter_spec(
    source: dict,
    gateway_routes: list[dict[str, str]],
    g5_routes: list[dict[str, str]],
    enable_g5: bool,
    docs_sha: str,
    gateway_sha: str,
    *,
    g5_authorized: bool = False,
    security_profile: str = "G7_AUTHENTICATED",
    enabled_providers: list[str] | None = None,
    authorized_public_allowlist: list[str] | None = None,
    exposure_config: dict | None = None,
) -> tuple[dict, dict]:
    if enable_g5 and not g5_authorized:
        raise ValueError(
            "El flag --enable-g5 por sí solo no autoriza publicación operativa; se requiere --g5-authorized explícito"
        )
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
            extract_operation_security_metadata(
                operation_id,
                method,
                path,
                operation,
                source,
                operation_id in g5_ids,
            )
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
        "securityProfile": security_profile,
        "enabledProviders": sorted(enabled_providers) if enabled_providers else [],
        "authorizedPublicAllowlist": sorted(authorized_public_allowlist) if authorized_public_allowlist else [],
        "g5Flag": bool(enable_g5),
        "g5EnabledByDefault": False,
        "exposureConfig": exposure_config or {"mode": "private-gateway-behind-apim"},
        "contractInventory": {
            "totalOperations": len(operation_index),
            "internalExcludedIds": sorted(private_ids),
            "g5CandidateIds": sorted(g5_ids),
            "legacyPricingExcludedIds": sorted(uncontracted),
        },
        "gatewayStaticRegistry": {
            "baseOperationCount": len(gateway_ids),
            "g5OverlayCount": len(g5_ids),
        },
        "privateOperationIds": sorted(private_ids),
        "excludedUncontractedLegacyOperationIds": sorted(uncontracted),
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
    parser.add_argument("--g5-authorized", action="store_true", help="Autorización operativa explícita para G5")
    parser.add_argument("--security-profile", default="G7_AUTHENTICATED")
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
        g5_authorized=args.g5_authorized,
        security_profile=args.security_profile,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    output_text = json.dumps(filtered, indent=2) + "\n"
    args.output.write_text(output_text, encoding="utf-8")
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
