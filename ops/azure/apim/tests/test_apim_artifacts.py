import importlib.util
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
                **self.private,
                "/publica": {
                    "get": {"operationId": "publica", "security": []}
                },
                "/segura": {"get": {"operationId": "segura"}},
                "/g5": {"post": {"operationId": "g5-operacion"}},
            },
        }

    def test_excludes_five_private_paths_and_g5_by_default(self):
        filtered, manifest = FILTER.filter_spec(
            self.source,
            ["publica", "segura"],
            ["g5-operacion"],
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
            ["publica", "segura"],
            ["g5-operacion"],
            True,
            "docs-sha",
            "gateway-sha",
        )
        by_id = {operation["operationId"]: operation for operation in manifest["operations"]}
        self.assertTrue(by_id["g5-operacion"]["g5OptIn"])
        self.assertFalse(by_id["publica"]["secured"])
        self.assertTrue(by_id["segura"]["secured"])

    def test_rejects_a_private_route_in_the_public_gateway_registry(self):
        with self.assertRaisesRegex(ValueError, "ruta interna"):
            FILTER.filter_spec(
                self.source,
                ["interna1", "publica"],
                ["g5-operacion"],
                False,
                "docs-sha",
                "gateway-sha",
            )

    def test_excludes_only_the_two_uncontracted_legacy_pricing_routes(self):
        _, manifest = FILTER.filter_spec(
            self.source,
            [
                "publica",
                "obtenerDefinicionPrecioProductoAdministracion",
                "obtenerDefinicionPrecioSkuAdministracion",
            ],
            ["g5-operacion"],
            False,
            "docs-sha",
            "gateway-sha",
        )
        self.assertEqual(
            manifest["excludedUncontractedLegacyOperationIds"],
            sorted(FILTER.LEGACY_UNCONTRACTED),
        )
        self.assertEqual([op["operationId"] for op in manifest["operations"]], ["publica"])


class ApimPolicyTests(unittest.TestCase):
    def setUp(self):
        self.parameters = {
            "apimSubnetResourceId": "/subscriptions/test/resourceGroups/lab/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apim",
            "gatewayBackendUrl": "https://gateway.internal.test",
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

    def test_parameter_preflight_requires_https_explicit_origins_and_valid_windows(self):
        PARAMS.validate(self.parameters)
        for change in (
            {"corsAllowedOrigins": ["*"]},
            {"corsAllowedOrigins": ["https://*.example.test"]},
            {"gatewayBackendUrl": "http://gateway.internal.test"},
            {"burstWindowSeconds": 301},
            {"quotaWindowSeconds": 120},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                PARAMS.validate(self.parameters | change)

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


if __name__ == "__main__":
    unittest.main()
