#!/usr/bin/env python3
"""Valida que el ARM compilado materialice el manifiesto APIM suministrado."""

import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILTER_SPEC = importlib.util.spec_from_file_location("filter_openapi", ROOT / "filter-openapi.py")
FILTER = importlib.util.module_from_spec(FILTER_SPEC)
assert FILTER_SPEC.loader is not None
FILTER_SPEC.loader.exec_module(FILTER)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate(
    template,
    filtered,
    manifest,
    expected_docs_sha,
    expected_gateway_sha,
    *,
    g5_authorized=False,
):
    FILTER.validate_artifact_pair(filtered, manifest)
    filter_metadata = filtered.get("x-apim-filter", {})
    for field, expected in (
        ("docsSha", expected_docs_sha),
        ("gatewaySha", expected_gateway_sha),
    ):
        if manifest.get(field) != expected or filter_metadata.get(field) != expected:
            raise ValueError(f"La procedencia {field} no corresponde a las revisiones integradas")
    resources = template.get("resources", {})
    variables = template.get("variables", {})
    policy = resources.get("operationPolicies")
    if not isinstance(policy, dict):
        raise ValueError("El ARM compilado no contiene operationPolicies")
    if policy.get("type") != "Microsoft.ApiManagement/service/apis/operations/policies":
        raise ValueError("operationPolicies no es un recurso policy de operación APIM")
    if policy.get("copy", {}).get("count") != "[length(variables('authorizedOperations'))]":
        raise ValueError("El bucle de políticas no está ligado a authorizedOperations")
    expected_name = "[format('{0}/{1}/{2}/policy', parameters('apimName'), variables('apiName'), variables('authorizedOperations')[copyIndex()].apimOperationId)]"
    if policy.get("name") != expected_name:
        raise ValueError("La jerarquía ARM de policy no usa APIM/API/apimOperationId/policy sobre authorizedOperations")
    required_dependencies = {"api", "openIdNamedValue", "issuerNamedValue", "audienceNamedValue"}
    if not required_dependencies.issubset(set(policy.get("dependsOn", []))):
        raise ValueError("Faltan dependencias de API o named values en las políticas")

    manifest_expression = variables.get("operationsManifest")
    if not isinstance(manifest_expression, str) or not manifest_expression.startswith("[variables('"):
        raise ValueError("El ARM no referencia una variable de manifiesto compilada")
    symbol = manifest_expression[len("[variables('") : -3]
    compiled_manifest = variables.get(symbol)
    if compiled_manifest != manifest:
        raise ValueError("El manifiesto compilado no corresponde al artefacto suministrado")
    if not manifest.get("operations"):
        raise ValueError("El manifiesto no contiene operaciones para generar políticas")
    if len(manifest.get("privateOperationIds", [])) != 5:
        raise ValueError("El manifiesto debe excluir exactamente cinco rutas privadas")
    operation_ids = {item["operationId"] for item in manifest["operations"]}
    if operation_ids.intersection(manifest["privateOperationIds"]):
        raise ValueError("Una operación privada está incluida en las políticas")
    if manifest.get("g5EnabledByDefault") is not False:
        raise ValueError("g5EnabledByDefault debe ser siempre false")
    g5_ops = [item for item in manifest["operations"] if item.get("g5OptIn")]
    if not g5_authorized:
        if g5_ops or manifest.get("g5Authorized") is True:
            raise ValueError("El manifiesto habilita rutas G5 sin opt-in autorizado")
    else:
        if manifest.get("g5Flag") is not True or manifest.get("g5Authorized") is not True:
            raise ValueError("Habilitación G5 inconsistente o sin autorización explícita")
        for g5_op in g5_ops:
            if not g5_op.get("scopes") or not g5_op.get("allowedClients"):
                raise ValueError(f"Operación G5 sin scopes o clientes contractuales: {g5_op['operationId']}")
    api_resource = resources.get("api", {})
    if api_resource.get("properties", {}).get("value") != "[variables('fixedFilteredOpenApi')]":
        raise ValueError("El recurso API en ARM debe consumir variables('fixedFilteredOpenApi') fijado")
    if variables.get("fixedFilteredOpenApi") != "[string(variables('fixedFilteredOpenApiObject'))]":
        raise ValueError("fixedFilteredOpenApi debe serializar fixedFilteredOpenApiObject")
    compiled_openapi = variables.get("fixedFilteredOpenApiObject")
    if not isinstance(compiled_openapi, dict) or FILTER.canonical_sha256(compiled_openapi) != manifest.get("filteredOpenApiCanonicalSha256"):
        raise ValueError("El OpenAPI embebido en ARM (fixedFilteredOpenApiObject) no coincide con el SHA canónico del manifiesto")
    if compiled_openapi != filtered:
        raise ValueError("El OpenAPI embebido en ARM no coincide exactamente con gateway-filtered.json")
    if set(manifest.get("excludedUncontractedLegacyOperationIds", [])) != set(FILTER.LEGACY_UNCONTRACTED):
        raise ValueError("Las exclusiones legacy de Pricing no corresponden al contrato")
    if len(filtered.get("paths", {})) == 0:
        raise ValueError("El OpenAPI filtrado está vacío")
    return len(manifest["operations"])


def validate_source_artifacts(
    source_openapi,
    gateway_routes_path,
    g5_routes_path,
    filtered,
    manifest,
    expected_docs_sha,
    expected_gateway_sha,
    *,
    mode="effective",
    security_profile="UNSPECIFIED",
    enabled_providers=None,
    authorized_public_allowlist=None,
    public_provider_exceptions=None,
    enable_g5=False,
    g5_authorized=False,
    allow_human_only_when_m2m_pending=False,
):
    source = FILTER.yaml.safe_load(source_openapi.read_text(encoding="utf-8"))
    g5_routes = FILTER.read_registry(g5_routes_path)
    if len(g5_routes) != 4:
        raise ValueError("El registro integrado debe contener exactamente las cuatro rutas G5")
    effective_publish = mode == "effective"
    generated_filtered, generated_manifest = FILTER.filter_spec(
        source,
        FILTER.read_registry(gateway_routes_path),
        g5_routes,
        enable_g5,
        expected_docs_sha,
        expected_gateway_sha,
        g5_authorized=g5_authorized,
        security_profile=security_profile,
        enabled_providers=enabled_providers or [],
        authorized_public_allowlist=authorized_public_allowlist or [],
        public_provider_exceptions=public_provider_exceptions or [],
        effective_publish=effective_publish,
        allow_human_only_when_m2m_pending=allow_human_only_when_m2m_pending,
    )
    if generated_filtered != filtered or generated_manifest != manifest:
        raise ValueError("Los artefactos APIM no se regeneran exactamente desde Docs y Gateway aprobados")
    if not enable_g5 and (
        {route["operationId"] for route in g5_routes}
        & {operation["operationId"] for operation in manifest["operations"]}
    ):
        raise ValueError("Una ruta G5 aparece en el manifiesto APIM sin opt-in")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--source-openapi", type=Path, required=True)
    parser.add_argument("--gateway-routes", type=Path, required=True)
    parser.add_argument("--g5-routes", type=Path, required=True)
    parser.add_argument("--expected-docs-sha", required=True)
    parser.add_argument("--expected-gateway-sha", required=True)
    parser.add_argument("--mode", choices=("effective", "candidate"), default="effective")
    parser.add_argument("--security-profile", default="UNSPECIFIED")
    parser.add_argument("--enabled-providers", nargs="*", default=[])
    parser.add_argument("--authorized-public-allowlist", nargs="*", default=[])
    parser.add_argument("--public-provider-exceptions", nargs="*", default=[])
    parser.add_argument("--enable-g5", action="store_true")
    parser.add_argument("--g5-authorized", action="store_true")
    parser.add_argument("--allow-human-only-when-m2m-pending", action="store_true")
    parser.add_argument("--filtered-openapi", type=Path, default=ROOT / "openapi/gateway-filtered.json")
    parser.add_argument("--manifest", type=Path, default=ROOT / "openapi/operation-security.json")
    args = parser.parse_args()
    filtered = load_json(args.filtered_openapi)
    manifest = load_json(args.manifest)
    validate_source_artifacts(
        args.source_openapi,
        args.gateway_routes,
        args.g5_routes,
        filtered,
        manifest,
        args.expected_docs_sha,
        args.expected_gateway_sha,
        mode=args.mode,
        security_profile=args.security_profile,
        enabled_providers=args.enabled_providers,
        authorized_public_allowlist=args.authorized_public_allowlist,
        public_provider_exceptions=args.public_provider_exceptions,
        enable_g5=args.enable_g5,
        g5_authorized=args.g5_authorized,
        allow_human_only_when_m2m_pending=args.allow_human_only_when_m2m_pending,
    )
    count = validate(
        load_json(args.template),
        filtered,
        manifest,
        args.expected_docs_sha,
        args.expected_gateway_sha,
        g5_authorized=args.g5_authorized,
    )
    print(f"ARM APIM: PASS ({count} políticas; 5 rutas privadas excluidas; G5 deshabilitado por defecto)")


if __name__ == "__main__":
    main()
