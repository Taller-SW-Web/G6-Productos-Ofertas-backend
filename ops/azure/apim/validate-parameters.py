#!/usr/bin/env python3
"""Preflight for an explicitly reviewed APIM parameter document."""

import argparse
from datetime import datetime, timezone
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


def validate(
    parameters: dict,
    filtered_openapi: dict,
    manifest: dict,
    *,
    expected_docs_sha: str,
    expected_gateway_sha: str,
    max_evidence_age_hours: int = 24,
) -> None:
    if not expected_docs_sha or not expected_gateway_sha:
        raise ValueError("expected_docs_sha y expected_gateway_sha son obligatorios")
    if manifest.get("publicationMode") != "effective" or manifest.get("effectivePublication", {}).get("authorized") is not True:
        raise ValueError(
            "Publicación efectiva bloqueada: se requiere publicationMode='effective' y effectivePublication.authorized=true "
            f"({manifest.get('effectivePublication', {}).get('blockedReasons', [])})"
        )

    for key in (
        "environmentTier",
        "expectedSubscriptionId",
        "expectedResourceGroup",
        "expectedEnvironment",
        "expectedGatewayResourceId",
        "expectedApimOriginCidrs",
        "apimSubnetResourceId",
        "gatewayBackendUrl",
        "azureCliEvidencePath",
        "operationalApprovalRef",
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
        "expectedOperationSetSha256",
        "expectedFilteredOpenApiSha256",
    ):
        if key not in parameters:
            raise ValueError(f"Falta parámetro obligatorio: {key}")

    tier = parameters["environmentTier"]
    if tier not in {"lab", "production"}:
        raise ValueError("environmentTier debe ser 'lab' o 'production'")

    if not isinstance(parameters["operationalApprovalRef"], str) or not parameters["operationalApprovalRef"].strip():
        raise ValueError("Falta operationalApprovalRef aprobado por Castilla/Infra")

    expected_cidrs = parameters["expectedApimOriginCidrs"]
    if not isinstance(expected_cidrs, list) or not expected_cidrs or any(not isinstance(c, str) or not c.strip() for c in expected_cidrs):
        raise ValueError("expectedApimOriginCidrs debe ser una lista no vacía de CIDRs APIM autorizados")

    cli_evidence_path = Path(str(parameters["azureCliEvidencePath"]))
    if not cli_evidence_path.exists() or cli_evidence_path.stat().st_size == 0:
        raise ValueError(
            "Deployment bloqueado: falta evidencia verificable de Azure CLI en azureCliEvidencePath"
        )
    cli_evidence = json.loads(cli_evidence_path.read_text(encoding="utf-8"))
    for req_field in ("subscriptionId", "resourceGroup", "environment", "capturedAtUtc", "sourceCommand", "acaEnvironment", "gatewayApp"):
        if not cli_evidence.get(req_field):
            raise ValueError(f"Evidencia Azure CLI incompleta: falta {req_field}")
    if cli_evidence["subscriptionId"] != parameters["expectedSubscriptionId"]:
        raise ValueError("subscriptionId de evidencia Azure CLI no coincide con expectedSubscriptionId")
    if cli_evidence["resourceGroup"] != parameters["expectedResourceGroup"]:
        raise ValueError("resourceGroup de evidencia Azure CLI no coincide con expectedResourceGroup")
    if cli_evidence["environment"] != parameters["expectedEnvironment"]:
        raise ValueError("environment de evidencia Azure CLI no coincide con expectedEnvironment")
    if not str(cli_evidence["sourceCommand"]).strip().startswith("az "):
        raise ValueError("Evidencia Azure CLI debe registrar comando az de solo lectura")
    captured_at = datetime.fromisoformat(str(cli_evidence["capturedAtUtc"]).replace("Z", "+00:00"))
    age_hours = (datetime.now(timezone.utc) - captured_at).total_seconds() / 3600.0
    if age_hours < 0 or age_hours > max_evidence_age_hours:
        raise ValueError("Evidencia Azure CLI caducada o con fecha inválida")
    if cli_evidence["acaEnvironment"].get("vnetConfiguration") is None:
        raise ValueError("Evidencia Azure CLI indica vnetConfiguration=null; red privada no acreditada")
    gateway_app = cli_evidence["gatewayApp"]
    if gateway_app.get("resourceId") != parameters["expectedGatewayResourceId"]:
        raise ValueError("gatewayApp.resourceId de evidencia Azure CLI no coincide con expectedGatewayResourceId")
    restrictions = gateway_app.get("ipSecurityRestrictions") or []
    allow_cidrs = {r.get("ipAddressRange") for r in restrictions if r.get("action") == "Allow" and r.get("ipAddressRange")}
    has_authorized_apim_allow = bool(allow_cidrs) and allow_cidrs.issubset(set(expected_cidrs))
    has_default_deny = gateway_app.get("external") is False or any(
        r.get("action") == "Deny" and r.get("ipAddressRange") in {"0.0.0.0/0", "*"} for r in restrictions
    )
    if not (gateway_app.get("external") is False or (has_authorized_apim_allow and has_default_deny)):
        raise ValueError("Evidencia Azure CLI no acredita restricción exacta al origen APIM autorizado ni denegación por defecto")
    if gateway_app.get("directRoutesBlocked") is not True:
        raise ValueError("Evidencia Azure CLI no acredita bloqueo de rutas directas alternativas")

    if manifest.get("docsSha") != expected_docs_sha:
        raise ValueError("docsSha del manifiesto no coincide con el SHA aprobado")
    if manifest.get("gatewaySha") != expected_gateway_sha:
        raise ValueError("gatewaySha del manifiesto no coincide con el SHA aprobado")

    if parameters["expectedOperationSetSha256"] != manifest.get("operationSetSha256"):
        raise ValueError("expectedOperationSetSha256 no coincide con el manifiesto efectivo")
    if parameters["expectedFilteredOpenApiSha256"] != manifest.get("filteredOpenApiCanonicalSha256"):
        raise ValueError("expectedFilteredOpenApiSha256 no coincide con el OpenAPI filtrado")

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
    if parameters["expectedFilteredOpenApiSha256"] != FILTER.canonical_sha256(filtered_openapi):
        raise ValueError("expectedFilteredOpenApiSha256 no coincide con el contenido de gateway-filtered.json")
    FILTER.validate_artifact_pair(filtered_openapi, manifest)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("parameters", type=Path, help="JSON local entregado para revisión")
    parser.add_argument("--openapi", type=Path, required=True, help="OpenAPI JSON filtrado")
    parser.add_argument("--manifest", type=Path, required=True, help="Manifiesto generado junto al OpenAPI")
    parser.add_argument("--expected-docs-sha", required=True, help="SHA aprobado de Docs")
    parser.add_argument("--expected-gateway-sha", required=True, help="SHA aprobado de Backend Gateway")
    args = parser.parse_args()
    validate(
        json.loads(args.parameters.read_text(encoding="utf-8")),
        json.loads(args.openapi.read_text(encoding="utf-8")),
        json.loads(args.manifest.read_text(encoding="utf-8")),
        expected_docs_sha=args.expected_docs_sha,
        expected_gateway_sha=args.expected_gateway_sha,
    )
    print("Parámetros APIM: PASS (validación local, sin acceso a Azure)")


if __name__ == "__main__":
    main()
