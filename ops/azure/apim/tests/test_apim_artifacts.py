import importlib.util
import json
import unittest
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("filter_openapi", ROOT / "filter-openapi.py")
FILTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(FILTER)
PARAM_SPEC = importlib.util.spec_from_file_location("validate_parameters", ROOT / "validate-parameters.py")
PARAMS = importlib.util.module_from_spec(PARAM_SPEC)
assert PARAM_SPEC.loader is not None
PARAM_SPEC.loader.exec_module(PARAMS)


class FilterOpenApiTests(unittest.TestCase):
    def setUp(self):
        self.private = {
            f"interna{i}": {
                "get": {"operationId": f"interna{i}", "x-internal": True}
            }
            for i in range(1, 6)
        }
        self.source = {
            "openapi": "3.0.3",
            "info": {"title": "test", "version": "1"},
            "security": [{"bearerAuth": []}],
            "paths": {
                **{f"/{path}": item for path, item in self.private.items()},
                "/publica": {
                    "get": {"operationId": "publica", "security": []}
                },
                "/segura": {"get": {"operationId": "segura"}},
                "/g5": {"post": {"operationId": "g5-operacion"}},
            },
            "servers": [{"url": "/api/v1"}],
        }
        self.gateway_routes = [
            {"method": "GET", "path": "/api/v1/publica", "operationId": "publica"},
            {"method": "GET", "path": "/api/v1/segura", "operationId": "segura"},
        ]
        self.g5_routes = [
            {"method": "POST", "path": "/api/v1/g5", "operationId": "g5-operacion"}
        ]

    def test_excludes_five_private_paths_and_g5_by_default(self):
        filtered, manifest = FILTER.filter_spec(
            self.source,
            self.gateway_routes,
            self.g5_routes,
            False,
            "docs-sha",
            "gateway-sha",
        )
        self.assertEqual(set(filtered["paths"]), {"/publica", "/segura"})
        self.assertEqual(len(manifest["privateOperationIds"]), 5)
        self.assertEqual(len(manifest["operations"]), 2)
        self.assertFalse(manifest["g5EnabledByDefault"])

    def test_g5_requires_explicit_opt_in_and_secured_metadata_is_preserved(self):
        _, manifest = FILTER.filter_spec(
            self.source,
            self.gateway_routes,
            self.g5_routes,
            True,
            "docs-sha",
            "gateway-sha",
        )
        by_id = {operation["operationId"]: operation for operation in manifest["operations"]}
        self.assertTrue(by_id["g5-operacion"]["g5OptIn"])
        self.assertFalse(by_id["publica"]["secured"])
        self.assertTrue(by_id["segura"]["secured"])
        for operation in manifest["operations"]:
            self.assertEqual(
                operation["apimOperationId"],
                FILTER.normalize_apim_operation_id(operation["operationId"]),
            )

    def test_rejects_a_private_route_in_the_public_gateway_registry(self):
        with self.assertRaisesRegex(ValueError, "ruta interna"):
            FILTER.filter_spec(
                self.source,
                [*self.gateway_routes, {"method": "GET", "path": "/api/v1/interna1", "operationId": "interna1"}],
                self.g5_routes,
                False,
                "docs-sha",
                "gateway-sha",
            )

    def test_excludes_only_the_two_uncontracted_legacy_pricing_routes(self):
        _, manifest = FILTER.filter_spec(
            self.source,
            [
                *self.gateway_routes[:1],
                {"method": "GET", "path": "/api/v1/legacy-a", "operationId": "obtenerDefinicionPrecioProductoAdministracion"},
                {"method": "GET", "path": "/api/v1/legacy-b", "operationId": "obtenerDefinicionPrecioSkuAdministracion"},
            ],
            self.g5_routes,
            False,
            "docs-sha",
            "gateway-sha",
        )
        self.assertEqual(
            manifest["excludedUncontractedLegacyOperationIds"],
            sorted(FILTER.LEGACY_UNCONTRACTED),
        )
        self.assertEqual([op["operationId"] for op in manifest["operations"]], ["publica"])

    def test_manifest_integrity_binds_exact_method_path_and_filtered_openapi(self):
        filtered, manifest = FILTER.filter_spec(
            self.source, self.gateway_routes, self.g5_routes, False, "docs-sha", "gateway-sha"
        )
        FILTER.validate_artifact_pair(filtered, manifest)
        stale = dict(manifest)
        stale["operations"] = [dict(manifest["operations"][0], method="POST"), *manifest["operations"][1:]]
        with self.assertRaisesRegex(ValueError, "no corresponde"):
            FILTER.validate_artifact_pair(filtered, stale)
        replaced = json.loads(json.dumps(filtered))
        replaced["paths"]["/publica"]["get"]["summary"] = "spec distinto"
        with self.assertRaisesRegex(ValueError, "SHA declarado"):
            FILTER.validate_artifact_pair(replaced, manifest)

    def test_route_method_and_path_must_match_the_contract(self):
        bad_registry = [dict(self.gateway_routes[0], path="/api/v1/otro")]
        with self.assertRaisesRegex(ValueError, "no corresponde al OpenAPI"):
            FILTER.filter_spec(self.source, bad_registry, self.g5_routes, False, "d", "g")

    def test_normalizes_operation_ids_and_fails_on_collisions(self):
        self.assertEqual(FILTER.normalize_apim_operation_id("Crear_Combo+V2"), "crear-combo-v2")
        self.assertEqual(FILTER.normalize_apim_operation_id("A" * 80), "a" * 76)
        collision_source = {
            "openapi": "3.0.3",
            "info": {"title": "test", "version": "1"},
            "servers": [{"url": "/api/v1"}],
            "paths": {
                "/foo-a": {"get": {"operationId": "foo_a"}},
                "/foo-b": {"get": {"operationId": "foo-a"}},
                **self.source["paths"],
            },
        }
        registry = [
            *self.gateway_routes,
            {"method": "GET", "path": "/api/v1/foo-a", "operationId": "foo_a"},
            {"method": "GET", "path": "/api/v1/foo-b", "operationId": "foo-a"},
        ]
        with self.assertRaisesRegex(ValueError, "Colisión"):
            FILTER.filter_spec(collision_source, registry, self.g5_routes, False, "d", "g")


class ApimPolicyTests(unittest.TestCase):
    def setUp(self):
        self.parameters = {
            "apimSubnetResourceId": "/subscriptions/test/resourceGroups/lab/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apim",
            "gatewayBackendUrl": "https://gateway.internal.test/api/v1",
            "g7Issuer": "https://g7.test/issuer",
            "g7OpenIdConfigurationUrl": "https://g7.test/.well-known/openid-configuration",
            "g7Audience": "g6-gateway",
            "corsAllowedOrigins": ["https://admin.test"],
            "burstCalls": 20,
            "burstWindowSeconds": 30,
            "quotaCalls": 1000,
            "quotaWindowSeconds": 86400,
            "loggerResourceId": "/subscriptions/test/resourceGroups/lab/providers/Microsoft.Insights/components/apim",
            "filteredOpenApi": "{}",
        }
        self.filtered = {"paths": {}}
        operation_set_hash = FILTER.canonical_sha256([])
        self.filtered["x-apim-filter"] = {"operationSetSha256": operation_set_hash}
        self.manifest = {
            "operations": [],
            "operationSetSha256": operation_set_hash,
            "filteredOpenApiCanonicalSha256": FILTER.canonical_sha256(self.filtered),
        }
        self.parameters["filteredOpenApi"] = json.dumps(self.filtered)

    def test_parameter_preflight_requires_https_explicit_origins_and_valid_windows(self):
        PARAMS.validate(self.parameters, self.filtered, self.manifest)
        for change in (
            {"corsAllowedOrigins": ["*"]},
            {"corsAllowedOrigins": ["https://*.example.test"]},
            {"gatewayBackendUrl": "http://gateway.internal.test/api/v1"},
            {"gatewayBackendUrl": "https://gateway.internal.test"},
            {"gatewayBackendUrl": "https://gateway.internal.test/api/v1/api/v1"},
            {"gatewayBackendUrl": "https://user:pw@gateway.internal.test/api/v1"},
            {"gatewayBackendUrl": "https://gateway.internal.test/api/v1?x=1"},
            {"burstWindowSeconds": 301},
            {"quotaWindowSeconds": 120},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                PARAMS.validate(self.parameters | change, self.filtered, self.manifest)
        with self.assertRaisesRegex(ValueError, "no coincide"):
            PARAMS.validate(
                self.parameters | {"filteredOpenApi": '{"paths":{"/sustituido":{}}}'},
                self.filtered,
                self.manifest,
            )

    def test_policies_are_valid_xml_and_keep_security_and_retry_controls(self):
        api_policy = (ROOT / "policies" / "api.xml").read_text(encoding="utf-8")
        secured_policy = (ROOT / "policies" / "operation-secured.xml").read_text(encoding="utf-8")
        public_policy = (ROOT / "policies" / "operation-public.xml").read_text(encoding="utf-8")
        for policy in (api_policy, secured_policy, public_policy):
            ElementTree.fromstring(policy)
        self.assertIn("{{cors-origin-elements}}", api_policy)
        self.assertIn("Retry-After", api_policy)
        self.assertIn('allow-credentials="false"', api_policy)
        self.assertNotIn("<origin>*</origin>", api_policy)
        self.assertIn("validate-jwt", secured_policy)
        self.assertIn("rate-limit-by-key", secured_policy)
        self.assertIn("quota-by-key", secured_policy)
        self.assertNotIn("validate-jwt", public_policy)

    def test_apim_is_developer_classic_and_diagnostics_never_capture_bodies(self):
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("name: 'Developer'", bicep)
        self.assertIn("virtualNetworkType: 'External'", bicep)
        self.assertIn("subnetResourceId: apimSubnetResourceId", bicep)
        self.assertIn("bytes: 0", bicep)
        self.assertIn("gatewayBackendUrl", bicep)

    def test_jwt_rate_identity_comes_only_from_validated_jwt_subject(self):
        policy = (ROOT / "policies" / "operation-secured.xml").read_text(encoding="utf-8")
        self.assertIn('output-token-variable-name="jwt"', policy)
        self.assertIn('context.Variables[&quot;jwt&quot;]', policy)
        self.assertIn("((Jwt)", policy)
        self.assertIn(").Subject", policy)
        self.assertIn('name="rateIdentity"', policy)
        self.assertIn('context.Variables[&quot;rateIdentity&quot;]', policy)
        self.assertIn('code="401"', policy)
        self.assertNotIn("context.Principal", policy)
        self.assertNotIn("context.Request.IpAddress", policy)
        self.assertNotIn("output-token-variable-name", (ROOT / "policies" / "operation-public.xml").read_text(encoding="utf-8"))

    def test_imported_policy_resource_uses_apim_normalized_id_and_named_value_dependencies(self):
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("${operation.apimOperationId}/policy", bicep)
        self.assertIn("operation.operationId\n    )", bicep)
        self.assertIn("openIdNamedValue", bicep)
        self.assertIn("issuerNamedValue", bicep)
        self.assertIn("audienceNamedValue", bicep)

    def test_generated_policy_ids_match_exact_imported_operation_set(self):
        filtered = json.loads((ROOT / "openapi" / "gateway-filtered.json").read_text(encoding="utf-8"))
        manifest = json.loads((ROOT / "openapi" / "operation-security.json").read_text(encoding="utf-8"))
        FILTER.validate_artifact_pair(filtered, manifest)
        operations = manifest["operations"]
        self.assertEqual(len({item["operationId"] for item in operations}), len(operations))
        self.assertEqual(len({item["apimOperationId"] for item in operations}), len(operations))
        for item in operations:
            self.assertEqual(item["apimOperationId"], FILTER.normalize_apim_operation_id(item["operationId"]))
            self.assertIn(item["operationId"], str(filtered["paths"][item["path"]][item["method"].lower()]))
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("[for operation in operationsManifest.operations", bicep)
        self.assertIn("${operation.apimOperationId}/policy", bicep)

    def test_gateway_prefix_maps_public_route_without_rewrite(self):
        backend = "https://gateway.private.test/api/v1"
        public = "/api/v1/productos"
        self.assertEqual(PARAMS.gateway_path_for_public_request(backend, public), "/api/v1/productos")
        api_policy = (ROOT / "policies" / "api.xml").read_text(encoding="utf-8")
        self.assertNotIn("rewrite-uri", api_policy)
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("path: 'api/v1'", bicep)


if __name__ == "__main__":
    unittest.main()
