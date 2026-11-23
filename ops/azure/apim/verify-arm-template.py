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


def validate(template, filtered, manifest):
    FILTER.validate_artifact_pair(filtered, manifest)
    resources = template.get("resources", {})
    variables = template.get("variables", {})
    policy = resources.get("operationPolicies")
    if not isinstance(policy, dict):
        raise ValueError("El ARM compilado no contiene operationPolicies")
    if policy.get("type") != "Microsoft.ApiManagement/service/apis/operations/policies":
        raise ValueError("operationPolicies no es un recurso policy de operación APIM")
    if policy.get("copy", {}).get("count") != "[length(variables('operationsManifest').operations)]":
        raise ValueError("El bucle de políticas no está ligado al manifiesto")
    expected_name = "[format('{0}/{1}/{2}/policy', parameters('apimName'), variables('apiName'), variables('operationsManifest').operations[copyIndex()].apimOperationId)]"
    if policy.get("name") != expected_name:
        raise ValueError("La jerarquía ARM de policy no usa APIM/API/apimOperationId/policy")
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
    if len(manifest.get("operations", [])) != 143:
        raise ValueError("El conjunto provisional debe contener exactamente 143 operaciones")
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--filtered-openapi", type=Path, default=ROOT / "openapi/gateway-filtered.json")
    parser.add_argument("--manifest", type=Path, default=ROOT / "openapi/operation-security.json")
    args = parser.parse_args()
    count = validate(load_json(args.template), load_json(args.filtered_openapi), load_json(args.manifest))
    print(f"ARM APIM: PASS ({count} políticas; 5 rutas privadas excluidas; G5 deshabilitado por defecto)")


if __name__ == "__main__":
    main()
