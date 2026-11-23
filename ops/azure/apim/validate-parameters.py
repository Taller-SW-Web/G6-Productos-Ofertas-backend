#!/usr/bin/env python3
"""Preflight for an explicitly reviewed APIM parameter document."""

import argparse
import importlib.util
import json
import re
from pathlib import Path
from urllib.parse import urlparse

FILTER_SPEC = importlib.util.spec_from_file_location(
    "filter_openapi", Path(__file__).resolve().with_name("filter-openapi.py")
)
FILTER = importlib.util.module_from_spec(FILTER_SPEC)
assert FILTER_SPEC.loader is not None
FILTER_SPEC.loader.exec_module(FILTER)

RESOURCE_ID = re.compile(r"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/.+$", re.I)
HOSTNAME = re.compile(
    r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}",
    re.I,
)


def validate_gateway_backend_url(value: str) -> None:
    parsed = urlparse(value)
    hostname = parsed.hostname or ""
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Puerto inválido en gatewayBackendUrl") from error
    if (
        parsed.scheme != "https"
        or not HOSTNAME.fullmatch(hostname)
        or parsed.path != "/api/v1"
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise ValueError(
            "gatewayBackendUrl debe ser https://<hostname-aprobado>/api/v1 "
            "sin credenciales, query, fragmento ni prefijos adicionales"
        )


def gateway_path_for_public_request(gateway_backend_url: str, public_path: str) -> str:
    validate_gateway_backend_url(gateway_backend_url)
    api_prefix = "/api/v1"
    if not public_path.startswith(api_prefix + "/"):
        raise ValueError("La ruta pública debe comenzar por /api/v1/")
    backend_path = urlparse(gateway_backend_url).path.rstrip("/")
    return backend_path + public_path[len(api_prefix) :]


def validate(parameters: dict, filtered_openapi: dict, manifest: dict) -> None:
    for key in (
        "apimSubnetResourceId",
        "gatewayBackendUrl",
        "g7Issuer",
        "g7OpenIdConfigurationUrl",
        "g7Audience",
        "corsAllowedOrigins",
        "burstCalls",
        "burstWindowSeconds",
        "quotaCalls",
        "quotaWindowSeconds",
        "loggerResourceId",
        "filteredOpenApi",
    ):
        if key not in parameters:
            raise ValueError(f"Falta parámetro obligatorio: {key}")

    for key in ("apimSubnetResourceId", "loggerResourceId"):
        if not RESOURCE_ID.fullmatch(parameters[key]):
            raise ValueError(f"Resource ID inválido: {key}")

    validate_gateway_backend_url(parameters["gatewayBackendUrl"])
    for key in ("g7OpenIdConfigurationUrl",):
        url = urlparse(parameters[key])
        if url.scheme != "https" or not url.hostname:
            raise ValueError(f"Se requiere URL HTTPS absoluta: {key}")
    for key in ("g7Issuer", "g7Audience"):
        if not isinstance(parameters[key], str) or not parameters[key].strip():
            raise ValueError(f"Parámetro vacío: {key}")

    origins = parameters["corsAllowedOrigins"]
    if not isinstance(origins, list) or not origins:
        raise ValueError("corsAllowedOrigins debe contener orígenes explícitos")
    for origin in origins:
        parsed = urlparse(origin)
        if (
            "*" in origin
            or parsed.scheme not in {"https", "http"}
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise ValueError("Origen CORS inválido o wildcard")

    for key in ("burstCalls", "burstWindowSeconds", "quotaCalls", "quotaWindowSeconds"):
        if not isinstance(parameters[key], int) or isinstance(parameters[key], bool) or parameters[key] < 1:
            raise ValueError(f"Debe ser entero positivo: {key}")
    if parameters["burstWindowSeconds"] > 300:
        raise ValueError("burstWindowSeconds no puede exceder 300 segundos")
    if parameters["quotaWindowSeconds"] < 300:
        raise ValueError("quotaWindowSeconds debe ser de al menos 300 segundos")
    if not isinstance(parameters["filteredOpenApi"], str) or not parameters["filteredOpenApi"].strip():
        raise ValueError("filteredOpenApi debe contener el contrato JSON filtrado")
    try:
        supplied_spec = json.loads(parameters["filteredOpenApi"])
    except json.JSONDecodeError as error:
        raise ValueError("filteredOpenApi no contiene JSON válido") from error
    if FILTER.canonical_sha256(supplied_spec) != FILTER.canonical_sha256(filtered_openapi):
        raise ValueError("filteredOpenApi no coincide con el artefacto validado")
    FILTER.validate_artifact_pair(filtered_openapi, manifest)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("parameters", type=Path, help="JSON local entregado para revisión")
    parser.add_argument("--openapi", type=Path, required=True, help="OpenAPI JSON filtrado")
    parser.add_argument("--manifest", type=Path, required=True, help="Manifiesto generado junto al OpenAPI")
    args = parser.parse_args()
    validate(
        json.loads(args.parameters.read_text(encoding="utf-8")),
        json.loads(args.openapi.read_text(encoding="utf-8")),
        json.loads(args.manifest.read_text(encoding="utf-8")),
    )
    print("Parámetros APIM: PASS (validación local, sin acceso a Azure)")


if __name__ == "__main__":
    main()
