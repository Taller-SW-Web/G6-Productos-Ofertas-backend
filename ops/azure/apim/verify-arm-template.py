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


def validate(template, filtered, manifest, expected_docs_sha, expected_gateway_sha):
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
    if manifest.get("g5EnabledByDefault") is not False or any(
        item.get("g5OptIn") for item in manifest["operations"]
    ):
        raise ValueError("El manifiesto habilita rutas G5 sin opt-in")
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
):
    source = FILTER.yaml.safe_load(source_openapi.read_text(encoding="utf-8"))
    g5_routes = FILTER.read_registry(g5_routes_path)
    if len(g5_routes) != 4:
        raise ValueError("El registro integrado debe contener exactamente las cuatro rutas G5")
    generated_filtered, generated_manifest = FILTER.filter_spec(
        source,
        FILTER.read_registry(gateway_routes_path),
        g5_routes,
        False,
        expected_docs_sha,
        expected_gateway_sha,
    )
    if generated_filtered != filtered or generated_manifest != manifest:
        raise ValueError("Los artefactos APIM no se regeneran exactamente desde Docs y Gateway aprobados")
    if {route["operationId"] for route in g5_routes} & {
        operation["operationId"] for operation in manifest["operations"]
    }:
        raise ValueError("Una ruta G5 aparece en el manifiesto APIM sin opt-in")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--source-openapi", type=Path, required=True)
    parser.add_argument("--gateway-routes", type=Path, required=True)
    parser.add_argument("--g5-routes", type=Path, required=True)
    parser.add_argument("--expected-docs-sha", required=True)
    parser.add_argument("--expected-gateway-sha", required=True)
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
    )
    count = validate(
        load_json(args.template), filtered, manifest, args.expected_docs_sha, args.expected_gateway_sha
    )
    print(f"ARM APIM: PASS ({count} políticas; 5 rutas privadas excluidas; G5 deshabilitado por defecto)")


if __name__ == "__main__":
    main()
