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
APPLICATION_INSIGHTS_RESOURCE_ID = re.compile(
    r"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Insights/components/[^/]+$",
    re.I,
)
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
        "environmentTier",
        "apimSubnetResourceId",
        "gatewayBackendUrl",
        "privateNetworkProof",
        "g7Issuer",
        "g7OpenIdConfigurationUrl",
        "g7Audience",
        "corsAllowedOrigins",
        "burstCalls",
        "burstWindowSeconds",
        "quotaCalls",
        "quotaWindowSeconds",
        "rateProfiles",
        "applicationInsightsResourceId",
        "applicationInsightsConnectionString",
        "filteredOpenApi",
    ):
        if key not in parameters:
            raise ValueError(f"Falta parámetro obligatorio: {key}")

    tier = parameters["environmentTier"]
    if tier not in {"lab", "production"}:
        raise ValueError("environmentTier debe ser 'lab' o 'production'")

    net_proof = parameters["privateNetworkProof"]
    if not isinstance(net_proof, dict):
        raise ValueError("privateNetworkProof debe ser un objeto verificable")
    if tier == "production":
        if net_proof.get("verified") is not True or net_proof.get("antiBypassVerified") is not True:
            raise ValueError(
                "Deployment bloqueado: gatewayBackendUrl requiere evidencia verificada de red privada y anti-bypass"
            )
        if not isinstance(parameters.get("approvedBy"), str) or not parameters["approvedBy"].strip():
            raise ValueError("Deployment productivo requiere approvedBy explícito")

    if not APPLICATION_INSIGHTS_RESOURCE_ID.fullmatch(
        parameters["applicationInsightsResourceId"]
    ):
        raise ValueError(
            "applicationInsightsResourceId debe identificar un componente Microsoft.Insights"
        )
    if (
        not isinstance(parameters["applicationInsightsConnectionString"], str)
        or not parameters["applicationInsightsConnectionString"].strip()
    ):
        raise ValueError("Falta applicationInsightsConnectionString segura")

    for key in ("apimSubnetResourceId",):
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
    if "rateProfiles" in parameters:
        profiles = parameters["rateProfiles"]
        if not isinstance(profiles, dict):
            raise ValueError("rateProfiles debe ser un objeto")
        missing_profiles = FILTER.KNOWN_RATE_PROFILES - profiles.keys()
        if missing_profiles:
            raise ValueError(f"Faltan perfiles de límites obligatorios: {sorted(missing_profiles)}")
        for profile_name, profile in profiles.items():
            if not isinstance(profile, dict):
                raise ValueError(f"Perfil inválido: {profile_name}")
            for metric in ("burstCalls", "burstWindowSeconds", "quotaCalls", "quotaWindowSeconds"):
                val = profile.get(metric)
                if not isinstance(val, int) or isinstance(val, bool) or val < 1:
                    raise ValueError(f"Valor inválido {metric} en perfil {profile_name}")
            if profile["burstWindowSeconds"] > 300:
                raise ValueError(f"burstWindowSeconds > 300 en perfil {profile_name}")
            if profile["quotaWindowSeconds"] < 300:
                raise ValueError(f"quotaWindowSeconds < 300 en perfil {profile_name}")
            concurrency = profile.get("maxConcurrency", 0)
            if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 0:
                raise ValueError(f"maxConcurrency inválido en perfil {profile_name}")
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
