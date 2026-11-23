#!/usr/bin/env python3
"""Preflight for an explicitly reviewed APIM parameter document."""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse

RESOURCE_ID = re.compile(r"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/.+$", re.I)


def validate(parameters: dict) -> None:
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

    for key in ("gatewayBackendUrl", "g7OpenIdConfigurationUrl"):
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("parameters", type=Path, help="JSON local entregado para revisión")
    args = parser.parse_args()
    validate(json.loads(args.parameters.read_text(encoding="utf-8")))
    print("Parámetros APIM: PASS (validación local, sin acceso a Azure)")


if __name__ == "__main__":
    main()
