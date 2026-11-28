import importlib.util
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_DOCS_SHA = "7e1435386d2a8dca51e586a12524d4d78ceb7738"
EXPECTED_GATEWAY_SHA = "097dac1bf4a8dcf5c6e799742d2df340f6d893d5"
SPEC = importlib.util.spec_from_file_location("filter_openapi", ROOT / "filter-openapi.py")
FILTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(FILTER)
PARAM_SPEC = importlib.util.spec_from_file_location("validate_parameters", ROOT / "validate-parameters.py")
PARAMS = importlib.util.module_from_spec(PARAM_SPEC)
assert PARAM_SPEC.loader is not None
PARAM_SPEC.loader.exec_module(PARAMS)
ARM_SPEC = importlib.util.spec_from_file_location("verify_arm_template", ROOT / "verify-arm-template.py")
ARM = importlib.util.module_from_spec(ARM_SPEC)
assert ARM_SPEC.loader is not None
ARM_SPEC.loader.exec_module(ARM)


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
            "security": [{"userBearer": []}],
            "paths": {
                **{f"/{path}": item for path, item in self.private.items()},
                "/publica": {
                    "get": {"operationId": "publica", "security": []}
                },
                "/segura": {"get": {"operationId": "segura"}},
                "/g5": {"post": {
                    "operationId": "g5-operacion",
                    "security": [{"serviceBearer": []}],
                    "x-service-audience": "api-productos",
                    "x-required-scope": "cupones:consumir",
                    "x-allowed-client-ids": ["modulo-ventas"],
                }},
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
        with self.assertRaisesRegex(ValueError, "--g5-authorized"):
            FILTER.filter_spec(self.source, self.gateway_routes, self.g5_routes, True, "docs", "gateway")
        _, manifest = FILTER.filter_spec(
            self.source,
            self.gateway_routes,
            self.g5_routes,
            True,
            "docs-sha",
            "gateway-sha",
            g5_authorized=True,
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
            sorted(FILTER.PRICING_ADMIN_IDS),
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
        from datetime import datetime, timezone

        self.temp_dir = tempfile.TemporaryDirectory(prefix="apim-preflight-")
        self.cli_evidence_path = Path(self.temp_dir.name) / "az-cli-evidence.json"
        self.cli_evidence_path.write_text(
            json.dumps(
                {
                    "subscriptionId": "sub-test",
                    "resourceGroup": "rg-lab",
                    "environment": "lab",
                    "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
                    "sourceCommand": "az containerapp show -n api-gateway -g rg-lab",
                    "acaEnvironment": {"vnetConfiguration": {"infrastructureSubnetId": "/subscriptions/sub-test/resourceGroups/rg-lab/providers/Microsoft.Network/virtualNetworks/vnet/subnets/aca"}},
                    "gatewayApp": {
                        "resourceId": "/subscriptions/sub-test/resourceGroups/rg-lab/providers/Microsoft.App/containerApps/api-gateway",
                        "external": False,
                        "directRoutesBlocked": True,
                    },
                }
            ),
            encoding="utf-8",
        )
        self.filtered = {
            "openapi": "3.0.3",
            "info": {"title": "t", "version": "0.7.0-rc.3"},
            "servers": [{"url": "/api/v1"}],
            "paths": {
                "/productos": {
                    "get": {
                        "operationId": "listarProductos",
                        "security": [{"userBearer": []}],
                    }
                }
            },
        }
        records = FILTER.operation_records(self.filtered)
        operation_set_hash = FILTER.canonical_sha256(records)
        self.filtered["x-apim-filter"] = {"operationSetSha256": operation_set_hash}
        filtered_hash = FILTER.canonical_sha256(self.filtered)
        self.manifest = {
            "docsSha": EXPECTED_DOCS_SHA,
            "gatewaySha": EXPECTED_GATEWAY_SHA,
            "publicationMode": "effective",
            "effectivePublication": {
                "authorized": True,
                "status": "AUTHORIZED",
                "publishedOperationIds": ["listarProductos"],
                "excludedOperations": [],
            },
            "operations": [
                {
                    "operationId": "listarProductos",
                    "apimOperationId": FILTER.normalize_apim_operation_id("listarProductos"),
                    "method": "GET",
                    "path": "/productos",
                    "secured": True,
                    "authSchemes": ["userBearer"],
                    "identityType": "human",
                    "securityAlternatives": [{"scheme": "userBearer", "identityType": "human", "roles": ["GESTOR_COMERCIAL"]}],
                    "rateProfile": "commercial_read",
                    "environmentEnabled": True,
                }
            ],
            "operationSetSha256": operation_set_hash,
            "filteredOpenApiCanonicalSha256": filtered_hash,
        }
        rate_profile = {
            "burstCalls": 20,
            "burstWindowSeconds": 30,
            "quotaCalls": 1000,
            "quotaWindowSeconds": 86400,
            "maxConcurrency": 0,
        }
        self.parameters = {
            "candidateApiName": "g6-h5-candidate",
            "candidateApiPath": "h5-candidate/api/v1",
            "environmentTier": "lab",
            "expectedSubscriptionId": "sub-test",
            "expectedResourceGroup": "rg-lab",
            "expectedEnvironment": "lab",
            "expectedGatewayResourceId": "/subscriptions/sub-test/resourceGroups/rg-lab/providers/Microsoft.App/containerApps/api-gateway",
            "expectedApimOriginCidrs": ["20.10.20.30/32"],
            "apimSubnetResourceId": "/subscriptions/sub-test/resourceGroups/rg-lab/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apim",
            "gatewayBackendUrl": "https://gateway.internal.test/api/v1",
            "azureCliEvidencePath": str(self.cli_evidence_path),
            "operationalApprovalRef": "CASTILLA-TEST-001",
            "g7Issuer": "https://g7.test/issuer",
            "g7OpenIdConfigurationUrl": "https://g7.test/.well-known/openid-configuration",
            "g7Audience": "g6-gateway",
            "corsAllowedOrigins": ["https://admin.test"],
            "burstCalls": 20,
            "burstWindowSeconds": 30,
            "quotaCalls": 1000,
            "quotaWindowSeconds": 86400,
            "rateProfiles": {name: dict(rate_profile) for name in FILTER.KNOWN_RATE_PROFILES},
            "applicationInsightsResourceId": "/subscriptions/sub-test/resourceGroups/rg-lab/providers/Microsoft.Insights/components/g6-h5-test",
            "applicationInsightsConnectionString": "test-placeholder-not-a-real-secret",
            "expectedOperationSetSha256": operation_set_hash,
            "expectedFilteredOpenApiSha256": filtered_hash,
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_parameter_preflight_requires_https_explicit_origins_and_valid_windows(self):
        PARAMS.validate(
            self.parameters,
            self.filtered,
            self.manifest,
            expected_docs_sha=EXPECTED_DOCS_SHA,
            expected_gateway_sha=EXPECTED_GATEWAY_SHA,
        )
        for unsafe in (
            {"candidateApiName": "g6-productos-ofertas"},
            {"candidateApiPath": "api/v1"},
        ):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                PARAMS.validate(
                    {**self.parameters, **unsafe}, self.filtered, self.manifest,
                    expected_docs_sha=EXPECTED_DOCS_SHA,
                    expected_gateway_sha=EXPECTED_GATEWAY_SHA,
                )
        # Integración completa de preflight con Modalidad B (external=true Allow-only, vnetConfiguration=None)
        from datetime import datetime, timezone

        mode_b_evidence = Path(self.temp_dir.name) / "az-mode-b.json"
        mode_b_evidence.write_text(
            json.dumps(
                {
                    "subscriptionId": "sub-test",
                    "resourceGroup": "rg-lab",
                    "environment": "lab",
                    "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
                    "sourceCommand": "az containerapp show -n api-gateway -g rg-lab",
                    "acaEnvironment": {"vnetConfiguration": None},
                    "gatewayApp": {
                        "resourceId": "/subscriptions/sub-test/resourceGroups/rg-lab/providers/Microsoft.App/containerApps/api-gateway",
                        "external": True,
                        "ipSecurityRestrictions": [{"action": "Allow", "ipAddressRange": "20.10.20.30/32"}],
                        "directRoutesBlocked": True,
                    },
                }
            ),
            encoding="utf-8",
        )
        PARAMS.validate(
            self.parameters | {"azureCliEvidencePath": str(mode_b_evidence)},
            self.filtered,
            self.manifest,
            expected_docs_sha=EXPECTED_DOCS_SHA,
            expected_gateway_sha=EXPECTED_GATEWAY_SHA,
        )

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
            {"applicationInsightsResourceId": "/subscriptions/test/resourceGroups/lab/providers/Microsoft.ApiManagement/service/apim/loggers/logger"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                PARAMS.validate(
                    self.parameters | change,
                    self.filtered,
                    self.manifest,
                    expected_docs_sha=EXPECTED_DOCS_SHA,
                    expected_gateway_sha=EXPECTED_GATEWAY_SHA,
                )
        with self.assertRaisesRegex(ValueError, "no coincide"):
            PARAMS.validate(
                self.parameters | {"expectedFilteredOpenApiSha256": "0" * 64},
                self.filtered,
                self.manifest,
                expected_docs_sha=EXPECTED_DOCS_SHA,
                expected_gateway_sha=EXPECTED_GATEWAY_SHA,
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

    def test_candidate_api_and_named_values_do_not_use_operational_ids(self):
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        secured = (ROOT / "policies" / "operation-secured.xml").read_text(encoding="utf-8")
        self.assertIn("name: '${apimName}/${candidateApiName}'", bicep)
        self.assertIn("path: candidateApiPath", bicep)
        self.assertNotIn("name: '${apimName}/g6-productos-ofertas'", bicep)
        for name in ("g7-openid-config-url", "g7-issuer", "g7-audience"):
            self.assertIn(f"g6-h5-candidate-{name}", bicep)
        self.assertIn("{{g6-h5-candidate-g7-openid-config-url}}", secured)
        self.assertIn("{{g6-h5-candidate-g7-issuer}}", secured)

    def test_application_insights_logger_uses_secure_connection_and_system_identity(self):
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("Microsoft.ApiManagement/service/loggers@2022-08-01", bicep)
        logger_block = bicep.split("resource applicationInsightsLogger", 1)[1].split("resource apiDiagnostics", 1)[0]
        self.assertIn("name: '${apimName}/g6-h5-candidate-applicationinsights'", logger_block)
        self.assertIn("apim", logger_block)
        self.assertIn("existingApim", logger_block)
        self.assertIn("loggerType: 'applicationInsights'", bicep)
        self.assertIn("resourceId: applicationInsightsResourceId", bicep)
        self.assertIn("connectionString: applicationInsightsConnectionString", bicep)
        self.assertIn("identityClientId: 'systemAssigned'", bicep)
        self.assertRegex(
            bicep,
            r"@secure\(\)\s*@description\([^\n]*\)\s*param applicationInsightsConnectionString string",
        )
        self.assertIn("loggerId: applicationInsightsLogger.id", bicep)
        diagnostics = bicep.split("resource apiDiagnostics", 1)[1]
        self.assertIn("loggerId: applicationInsightsLogger.id", diagnostics)
        self.assertNotIn("loggerResourceId", bicep)
        self.assertNotRegex(bicep, r"InstrumentationKey=[0-9a-fA-F-]{36}")
        validator = (ROOT / "validate-parameters.py").read_text(encoding="utf-8")
        self.assertIn("applicationInsightsResourceId", validator)
        self.assertNotIn("loggerResourceId", validator)
        for candidate in ROOT.rglob("*"):
            if candidate.is_file() and candidate.suffix.lower() in {".bicep", ".json", ".md", ".py", ".xml"}:
                if candidate.resolve() == Path(__file__).resolve():
                    continue
                contents = candidate.read_text(encoding="utf-8")
                self.assertNotIn("InstrumentationKey=", contents, candidate.as_posix())
                self.assertNotIn("SharedAccessKey=", contents, candidate.as_posix())

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
        root = ElementTree.fromstring(policy)
        body = root.find(".//when/return-response/set-body")
        self.assertIsNotNone(body)
        problem = json.loads(body.text or "{}")
        self.assertEqual(
            problem,
            {
                "type": "about:blank",
                "title": "No autorizado",
                "status": 401,
                "code": "TOKEN_INVALIDO",
            },
        )
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
        self.assertIn("var publicationGatePassed", bicep)
        self.assertIn("[for operation in authorizedOperations", bicep)
        self.assertIn("${operation.apimOperationId}/policy", bicep)

    def test_final_manifest_keeps_h5_operation_count_and_exclusions(self):
        manifest = json.loads((ROOT / "openapi" / "operation-security.json").read_text(encoding="utf-8"))
        operations = manifest["operations"]
        self.assertEqual(len(operations), 151)
        self.assertEqual(sum(operation["secured"] for operation in operations), 151)
        self.assertEqual(sum(not operation["secured"] for operation in operations), 0)
        self.assertEqual(len(manifest["privateOperationIds"]), 5)
        self.assertFalse(manifest["g5EnabledByDefault"])
        g5 = {op["operationId"]: op for op in operations if op["g5OptIn"]}
        expected = {
            "admitirConsumoCuponH5": ("POST", "/cupones/consumos", "cupones:consumir"),
            "admitirRestauracionCuponH5": ("POST", "/cupones/restauraciones", "cupones:restaurar"),
            "obtenerOperacionCuponH5": ("GET", "/cupones/operaciones/{operationId}", "cupones:operaciones:leer"),
            "obtenerEstadoReservaH5": ("GET", "/inventario/reservas/{reservaId}/estado", "inventario:reservas:estado:leer"),
        }
        self.assertEqual(set(g5), set(expected))
        self.assertTrue(manifest["g5Authorized"])
        self.assertFalse(manifest["effectivePublication"]["authorized"])
        filtered = json.loads((ROOT / "openapi" / "gateway-filtered.json").read_text(encoding="utf-8"))
        for operation_id, (method, path, scope) in expected.items():
            with self.subTest(operation_id=operation_id):
                op = g5[operation_id]
                self.assertEqual((op["method"], op["path"], op["scopes"]), (method, path, [scope]))
                self.assertEqual(op["authSchemes"], ["serviceBearer"])
                self.assertEqual(op["allowedClients"], ["modulo-ventas"])
                self.assertEqual(op["audience"], "api-productos")
                invalid = copy.deepcopy(manifest)
                modified_op = next(item for item in invalid["operations"] if item["operationId"] == operation_id)
                modified_op["securityAlternatives"][0]["allowedClients"] = ["modulo-postventa"]
                with self.assertRaisesRegex(ValueError, "Seguridad contractual G5 inconsistente"):
                    FILTER.validate_artifact_pair(filtered, invalid)
        self.assertEqual(manifest["excludedUncontractedLegacyOperationIds"], [])
        pricing = {op["operationId"]: op for op in operations if op["operationId"] in FILTER.PRICING_ADMIN_IDS}
        self.assertEqual(set(pricing), FILTER.PRICING_ADMIN_IDS)
        for op in pricing.values():
            self.assertEqual(op["method"], "GET")
            self.assertEqual(op["authSchemes"], ["userBearer"])
            self.assertEqual(op["roles"], ["GESTOR_COMERCIAL"])
            self.assertEqual(op["rateProfile"], "admin_read")
            self.assertFalse(op["g5OptIn"])
            invalid_pricing = copy.deepcopy(manifest)
            mod_pricing = next(item for item in invalid_pricing["operations"] if item["operationId"] == op["operationId"])
            mod_pricing["roles"] = ["ADMINISTRADOR"]
            with self.assertRaisesRegex(ValueError, "Seguridad contractual Pricing inconsistente"):
                FILTER.validate_artifact_pair(filtered, invalid_pricing)

    def test_gateway_prefix_maps_public_route_without_rewrite(self):
        backend = "https://gateway.private.test/api/v1"
        public = "/api/v1/productos"
        self.assertEqual(PARAMS.gateway_path_for_public_request(backend, public), "/api/v1/productos")
        api_policy = (ROOT / "policies" / "api.xml").read_text(encoding="utf-8")
        self.assertNotIn("rewrite-uri", api_policy)
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("path: candidateApiPath", bicep)


class CompiledArmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        template_path = os.environ.get("APIM_ARM_TEMPLATE")
        if not template_path:
            with tempfile.TemporaryDirectory(prefix="apim-h5-arm-") as temp_dir:
                template_path = str(Path(temp_dir) / "template.json")
                subprocess.run(
                    ["az", "bicep", "build", "--file", str(ROOT / "main.bicep"), "--outfile", template_path],
                    check=True,
                )
                cls.template = json.loads(Path(template_path).read_text(encoding="utf-8"))
        else:
            cls.template = json.loads(Path(template_path).read_text(encoding="utf-8"))
        cls.filtered = json.loads((ROOT / "openapi" / "gateway-filtered.json").read_text(encoding="utf-8"))
        cls.manifest = json.loads((ROOT / "openapi" / "operation-security.json").read_text(encoding="utf-8"))

    def test_source_provenance_rebuilds_exact_openapi_and_manifest(self):
        source = {
            "openapi": "3.1.0",
            "info": {"title": "fixture", "version": "0.7.0-rc.3"},
            "servers": [{"url": "/api/v1"}],
            "security": [{"userBearer": []}],
            "paths": {
                **{
                    f"/interno/{index}": {
                        "get": {"operationId": f"interno{index}", "x-internal": True}
                    }
                    for index in range(1, 6)
                },
                "/productos": {
                    "get": {"operationId": "listarProductos", "summary": "Listado"}
                },
                **{
                    f"/g5/{index}": {
                        "get": {"operationId": f"operacionG5{index}"}
                    }
                    for index in range(1, 5)
                },
            },
        }
        with tempfile.TemporaryDirectory(prefix="apim-source-integrity-") as temp_dir:
            directory = Path(temp_dir)
            source_path = directory / "openapi.yaml"
            gateway_path = directory / "contract-routes.ts"
            g5_path = directory / "g5-h5-routes.ts"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            gateway_path.write_text(
                "[{ method: 'GET', path: '/api/v1/productos', operationId: 'listarProductos' }]",
                encoding="utf-8",
            )
            g5_path.write_text(
                "[\n"
                + ",\n".join(
                    f"{{ method: 'GET', path: '/api/v1/g5/{index}', operationId: 'operacionG5{index}' }}"
                    for index in range(1, 5)
                )
                + "\n]",
                encoding="utf-8",
            )
            filtered, manifest = FILTER.filter_spec(
                source,
                FILTER.read_registry(gateway_path),
                FILTER.read_registry(g5_path),
                False,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
            )
            ARM.validate_source_artifacts(
                source_path,
                gateway_path,
                g5_path,
                filtered,
                manifest,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
                mode="candidate",
            )
            filtered["paths"]["/productos"]["get"]["summary"] = "Documento obsoleto"
            with self.assertRaisesRegex(ValueError, "no se regeneran exactamente"):
                ARM.validate_source_artifacts(
                    source_path,
                    gateway_path,
                    g5_path,
                    filtered,
                    manifest,
                    EXPECTED_DOCS_SHA,
                    EXPECTED_GATEWAY_SHA,
                    mode="candidate",
                )

    def test_compiled_arm_has_exact_hierarchical_policy_set_and_exclusions(self):
        self.assertEqual(
            ARM.validate(
                self.template,
                self.filtered,
                self.manifest,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
                g5_authorized=True,
            ),
            len(self.manifest["operations"]),
        )

    def test_compiled_arm_rejects_wrong_policy_hierarchy_or_dependencies(self):
        for change in ("name", "dependsOn"):
            mutated = copy.deepcopy(self.template)
            if change == "name":
                mutated["resources"]["operationPolicies"]["name"] = "[format('{0}/{1}/policy', 'wrong', 'id')]"
            else:
                mutated["resources"]["operationPolicies"]["dependsOn"].remove("issuerNamedValue")
            with self.subTest(change=change), self.assertRaises(ValueError):
                ARM.validate(
                    mutated,
                    self.filtered,
                    self.manifest,
                    EXPECTED_DOCS_SHA,
                    EXPECTED_GATEWAY_SHA,
                g5_authorized=True,
                )

    def test_compiled_arm_rejects_stale_manifest_or_private_route_leak(self):
        stale = copy.deepcopy(self.template)
        symbol = stale["variables"]["operationsManifest"][len("[variables('") : -3]
        stale["variables"][symbol]["operations"][0]["operationId"] = "operacion-obsoleta"
        with self.assertRaisesRegex(ValueError, "manifiesto compilado"):
            ARM.validate(
                stale,
                self.filtered,
                self.manifest,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
                g5_authorized=True,
            )
        leaked = copy.deepcopy(self.manifest)
        leaked["operations"][0]["operationId"] = leaked["privateOperationIds"][0]
        with self.assertRaises(ValueError):
            ARM.validate(
                self.template,
                self.filtered,
                leaked,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
                g5_authorized=True,
            )

    def test_compiled_arm_rejects_stale_contract_or_gateway_provenance(self):
        for field in ("docsSha", "gatewaySha"):
            stale = copy.deepcopy(self.manifest)
            stale[field] = "0" * 40
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "procedencia"):
                ARM.validate(
                    self.template,
                    self.filtered,
                    stale,
                    EXPECTED_DOCS_SHA,
                    EXPECTED_GATEWAY_SHA,
                g5_authorized=True,
                )


class ApimClosureRequirementsTests(unittest.TestCase):
    def test_enriched_manifest_and_fail_closed_effective_publication(self):
        manifest = json.loads((ROOT / "openapi/operation-security.json").read_text(encoding="utf-8"))
        self.assertIn("contractInventory", manifest)
        self.assertIn("gatewayStaticRegistry", manifest)
        self.assertIn("candidateCatalog", manifest)
        self.assertIn("effectivePublication", manifest)
        self.assertFalse(manifest["effectivePublication"]["authorized"])
        self.assertFalse(manifest["g5EnabledByDefault"])

        by_id = {op["operationId"]: op for op in manifest["operations"]}
        for dual_id in ("obtenerCombo", "consultarDisponibilidadCombo"):
            self.assertEqual(by_id[dual_id]["identityType"], "human_or_m2m")
            schemes = {alt["scheme"]: alt for alt in by_id[dual_id]["securityAlternatives"]}
            self.assertEqual(set(schemes.keys()), {"userBearer", "serviceBearer"})
            self.assertFalse(schemes["userBearer"]["audienceRequired"])
            self.assertTrue(schemes["serviceBearer"]["audienceRequired"])

        for op in manifest["operations"]:
            self.assertFalse(op["environmentEnabled"])
            for key in (
                "authSchemes",
                "identityType",
                "securityAlternatives",
                "issuerRequired",
                "audienceRequired",
                "scopes",
                "roles",
                "allowedClients",
                "clientAllowlistStatus",
                "introspectionRequired",
                "exposureProfile",
                "rateProfile",
                "environmentEnabled",
            ):
                self.assertIn(key, op)

    def test_effective_publish_blocks_without_providers_or_pending_allowlist(self):
        private = {
            f"interna{i}": {"get": {"operationId": f"interna{i}", "x-internal": True}}
            for i in range(1, 6)
        }
        spec = {
            "openapi": "3.0.3",
            "info": {"title": "t", "version": "1"},
            "paths": {
                **{f"/{p}": item for p, item in private.items()},
                "/combo": {
                    "get": {
                        "operationId": "obtenerCombo",
                        "security": [{"userBearer": []}, {"serviceBearer": []}],
                        "x-service-audience": "api-productos",
                        "x-required-scope": "combos:leer",
                    }
                },
                "/m2m-pending": {
                    "get": {
                        "operationId": "consultarDisponibilidadCombo",
                        "security": [{"serviceBearer": []}],
                        "x-service-audience": "api-productos",
                        "x-required-scope": "combos:leer",
                    }
                },
            },
            "servers": [{"url": "/api/v1"}],
        }
        routes = [
            {"method": "GET", "path": "/api/v1/combo", "operationId": "obtenerCombo", "service": "combos-svc"},
            {"method": "GET", "path": "/api/v1/m2m-pending", "operationId": "consultarDisponibilidadCombo", "service": "combos-svc"},
        ]
        with self.assertRaisesRegex(ValueError, "Publicación efectiva bloqueada"):
            FILTER.filter_spec(spec, routes, [], False, "d", "g", effective_publish=True)

        # APIM-R3-01: human_or_m2m con M2M pendiente se bloquea por defecto (sin allow_human_only_when_m2m_pending)
        with self.assertRaisesRegex(ValueError, "Publicación efectiva bloqueada"):
            FILTER.filter_spec(
                spec,
                routes,
                [],
                False,
                "d",
                "g",
                security_profile="G7_AUTHENTICATED",
                enabled_providers=["combos-svc"],
                effective_publish=True,
            )

        # APIM-R3-01: con allow_human_only_when_m2m_pending=True publica solo alternativa humana explícita
        filtered, manifest = FILTER.filter_spec(
            spec,
            routes,
            [],
            False,
            "d",
            "g",
            security_profile="G7_AUTHENTICATED",
            enabled_providers=["combos-svc"],
            effective_publish=True,
            allow_human_only_when_m2m_pending=True,
        )
        self.assertTrue(manifest["effectivePublication"]["authorized"])
        self.assertEqual(manifest["effectivePublication"]["publishedOperationIds"], ["obtenerCombo"])
        self.assertEqual(manifest["operations"][0]["identityType"], "human")
        self.assertEqual(manifest["operations"][0]["roles"], ["GESTOR_COMERCIAL"])
        self.assertEqual(manifest["operations"][0]["m2mAlternativeExcludedReason"], "PENDING_G7_ALLOWLIST")
        self.assertEqual(set(filtered["paths"].keys()), {"/combo"})
        self.assertEqual(filtered["paths"]["/combo"]["get"]["security"], [{"userBearer": []}])
        self.assertNotIn("x-service-audience", filtered["paths"]["/combo"]["get"])
        self.assertNotIn("x-required-scope", filtered["paths"]["/combo"]["get"])
        self.assertIn(
            {"operationId": "consultarDisponibilidadCombo", "reason": "PENDING_G7_ALLOWLIST"},
            manifest["effectivePublication"]["excludedOperations"],
        )

        # APIM-R4-01 negativo: OpenAPI que anuncia serviceBearer cuando manifiesto permite solo userBearer
        tampered = copy.deepcopy(filtered)
        tampered["paths"]["/combo"]["get"]["security"] = [{"userBearer": []}, {"serviceBearer": []}]
        tampered_manifest = copy.deepcopy(manifest)
        tampered_manifest["filteredOpenApiCanonicalSha256"] = FILTER.canonical_sha256(tampered)
        with self.assertRaisesRegex(ValueError, "Inconsistencia entre security"):
            FILTER.validate_artifact_pair(tampered, tampered_manifest)

    def test_human_role_parity_default_explicit_and_mismatch(self):
        private = {
            f"interna{i}": {"get": {"operationId": f"interna{i}", "x-internal": True}}
            for i in range(1, 6)
        }
        spec = {
            "openapi": "3.0.3",
            "info": {"title": "t", "version": "1"},
            "paths": {
                **{f"/{p}": item for p, item in private.items()},
                "/sin-rol": {"get": {"operationId": "opSinRol", "security": [{"userBearer": []}]}},
                "/con-rol": {
                    "get": {
                        "operationId": "opConRol",
                        "security": [{"userBearer": []}],
                        "x-required-role": "ADMIN_SISTEMA",
                    }
                },
            },
            "servers": [{"url": "/api/v1"}],
        }
        routes = [
            {"method": "GET", "path": "/api/v1/sin-rol", "operationId": "opSinRol", "service": "catalog-svc"},
            {"method": "GET", "path": "/api/v1/con-rol", "operationId": "opConRol", "service": "catalog-svc"},
        ]
        _, manifest = FILTER.filter_spec(
            spec, routes, [], False, "d", "g",
            security_profile="G7_AUTHENTICATED", enabled_providers=["catalog-svc"], effective_publish=True,
        )
        by_id = {op["operationId"]: op for op in manifest["operations"]}
        self.assertEqual(by_id["opSinRol"]["roles"], ["GESTOR_COMERCIAL"])
        self.assertEqual(by_id["opConRol"]["roles"], ["ADMIN_SISTEMA"])

        # Discrepancia explícita entre rol Docs y Gateway bloquea generación
        bad_routes = [
            {"method": "GET", "path": "/api/v1/sin-rol", "operationId": "opSinRol", "service": "catalog-svc"},
            {
                "method": "GET",
                "path": "/api/v1/con-rol",
                "operationId": "opConRol",
                "service": "catalog-svc",
                "role": "OTRO_ROL",
            },
        ]
        with self.assertRaisesRegex(ValueError, "Discrepancia explícita de rol"):
            FILTER.filter_spec(spec, bad_routes, [], False, "d", "g")

    def test_effective_g5_opt_in_reproducibility_and_arm_fixed_openapi(self):
        private = {
            f"interna{i}": {"get": {"operationId": f"interna{i}", "x-internal": True}}
            for i in range(1, 6)
        }
        g5_paths = {
            f"/g5/{i}": {
                "post": {
                    "operationId": f"operacionG5{i}",
                    "security": [{"serviceBearer": []}],
                    "x-service-audience": "api-productos",
                    "x-required-scope": "cupones:consumir",
                    "x-allowed-client-ids": ["modulo-ventas"],
                }
            }
            for i in range(1, 5)
        }
        spec = {
            "openapi": "3.1.0",
            "info": {"title": "fixture", "version": "0.7.0-rc.3"},
            "servers": [{"url": "/api/v1"}],
            "paths": {
                **{f"/{p}": item for p, item in private.items()},
                "/productos": {
                    "get": {"operationId": "listarProductos", "security": [{"userBearer": []}]}
                },
                **g5_paths,
            },
        }
        with tempfile.TemporaryDirectory(prefix="apim-effective-g5-") as tmp:
            d = Path(tmp)
            src = d / "openapi.yaml"
            gw = d / "contract-routes.ts"
            g5 = d / "g5-h5-routes.ts"
            src.write_text(json.dumps(spec), encoding="utf-8")
            gw.write_text(
                "[\n"
                "{ method: 'GET', path: '/api/v1/productos', operationId: 'listarProductos', service: 'catalog-svc' },\n"
                "{ method: 'GET', path: '/api/v1/legacy-a', operationId: 'obtenerDefinicionPrecioProductoAdministracion', service: 'pricing-svc' },\n"
                "{ method: 'GET', path: '/api/v1/legacy-b', operationId: 'obtenerDefinicionPrecioSkuAdministracion', service: 'pricing-svc' }\n"
                "]",
                encoding="utf-8",
            )
            g5.write_text("[\n" + ",\n".join(f"{{ method: 'POST', path: '/api/v1/g5/{i}', operationId: 'operacionG5{i}', service: 'promotions-svc' }}" for i in range(1, 5)) + "\n]", encoding="utf-8")
            filtered, manifest = FILTER.filter_spec(
                spec,
                FILTER.read_registry(gw),
                FILTER.read_registry(g5),
                True,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
                g5_authorized=True,
                security_profile="G7_AUTHENTICATED",
                enabled_providers=["catalog-svc", "promotions-svc"],
                effective_publish=True,
            )
            ARM.validate_source_artifacts(
                src, gw, g5, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA,
                mode="effective",
                security_profile="G7_AUTHENTICATED",
                enabled_providers=["catalog-svc", "promotions-svc"],
                enable_g5=True,
                g5_authorized=True,
            )
            fake_arm = {
                "variables": {
                    "operationsManifest": "[variables('compiled')]",
                    "compiled": manifest,
                    "fixedFilteredOpenApi": "[string(variables('fixedFilteredOpenApiObject'))]",
                    "fixedFilteredOpenApiObject": filtered,
                },
                "resources": {
                    "api": {"properties": {"value": "[variables('fixedFilteredOpenApi')]"}},
                    "operationPolicies": {
                        "type": "Microsoft.ApiManagement/service/apis/operations/policies",
                        "copy": {"count": "[length(variables('authorizedOperations'))]"},
                        "name": "[format('{0}/{1}/{2}/policy', parameters('apimName'), parameters('candidateApiName'), variables('authorizedOperations')[copyIndex()].apimOperationId)]",
                        "dependsOn": ["api", "openIdNamedValue", "issuerNamedValue", "audienceNamedValue"],
                    },
                },
            }
            ARM.validate(fake_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)
            # Negativo: G5 presente sin autorización
            with self.assertRaisesRegex(ValueError, "sin opt-in autorizado"):
                ARM.validate(fake_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=False)
            # Negativo: OpenAPI embebido en ARM sustituido con ruta extra
            tampered_arm = copy.deepcopy(fake_arm)
            tampered_arm["variables"]["fixedFilteredOpenApiObject"]["paths"]["/extra"] = {"get": {"operationId": "extra"}}
            with self.assertRaisesRegex(ValueError, "SHA canónico"):
                ARM.validate(tampered_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)
            # Negativo: OpenAPI intercambiado en ARM por parámetro
            fake_arm["resources"]["api"]["properties"]["value"] = "[parameters('filteredOpenApi')]"
            with self.assertRaisesRegex(ValueError, "fixedFilteredOpenApi"):
                ARM.validate(fake_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)

            # R6-03: alias indirectos $fxv#0, ciclos, faltantes y expresiones no permitidas
            indirect_arm = copy.deepcopy(fake_arm)
            indirect_arm["resources"]["api"]["properties"]["value"] = "[variables('fixedFilteredOpenApi')]"
            indirect_arm["variables"]["fixedFilteredOpenApiObject"] = "[variables('$fxv#0')]"
            indirect_arm["variables"]["$fxv#0"] = filtered
            ARM.validate(indirect_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)

            cyclic_arm = copy.deepcopy(indirect_arm)
            cyclic_arm["variables"]["$fxv#0"] = "[variables('fixedFilteredOpenApiObject')]"
            with self.assertRaisesRegex(ValueError, "Referencia circular"):
                ARM.validate(cyclic_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)

            missing_arm = copy.deepcopy(indirect_arm)
            missing_arm["variables"]["fixedFilteredOpenApiObject"] = "[variables('$fxv#999')]"
            with self.assertRaisesRegex(ValueError, "Variable ARM inexistente"):
                ARM.validate(missing_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)

            param_arm = copy.deepcopy(indirect_arm)
            param_arm["variables"]["fixedFilteredOpenApiObject"] = "[parameters('evilParam')]"
            with self.assertRaisesRegex(ValueError, "Expresión ARM no permitida"):
                ARM.validate(param_arm, filtered, manifest, EXPECTED_DOCS_SHA, EXPECTED_GATEWAY_SHA, g5_authorized=True)

    def test_rejects_unknown_security_profile_and_public_without_enabled_provider(self):
        private = {
            f"interna{i}": {"get": {"operationId": f"interna{i}", "x-internal": True}}
            for i in range(1, 6)
        }
        spec = {
            "openapi": "3.0.3",
            "info": {"title": "t", "version": "1"},
            "paths": {
                **{f"/{p}": item for p, item in private.items()},
                "/seo": {"get": {"operationId": "seoPublico", "security": []}},
            },
            "servers": [{"url": "/api/v1"}],
        }
        routes = [{"method": "GET", "path": "/api/v1/seo", "operationId": "seoPublico", "service": "taxonomy-svc"}]
        with self.assertRaisesRegex(ValueError, "securityProfile no reconocido"):
            FILTER.filter_spec(spec, routes, [], False, "d", "g", security_profile="INVENTADO")
        with self.assertRaisesRegex(ValueError, "PUBLIC_READ_ONLY retirado bajo política universal G7"):
            FILTER.filter_spec(
                spec,
                routes,
                [],
                False,
                "d",
                "g",
                security_profile="PUBLIC_READ_ONLY",
                authorized_public_allowlist=["seoPublico"],
                effective_publish=True,
            )

    def test_policies_and_bicep_enforce_canonical_uuid_dual_auth_and_profiles(self):
        api_xml = (ROOT / "policies/api.xml").read_text(encoding="utf-8")
        self.assertIn("System.Text.RegularExpressions.Regex.IsMatch", api_xml)
        self.assertNotIn("Guid.TryParse", api_xml)
        self.assertIn("<header>Content-Disposition</header>", api_xml)
        self.assertIn("<header>Location</header>", api_xml)
        self.assertIn('buffer-request-body="false"', api_xml)
        self.assertIn('buffer-response="false"', api_xml)
        self.assertIn("<on-error>", api_xml)

        secured_xml = (ROOT / "policies/operation-secured.xml").read_text(encoding="utf-8")
        self.assertIn("{{audience-check-element}}", secured_xml)
        self.assertIn("human_or_m2m", secured_xml)
        self.assertIn("SCOPE_INSUFICIENTE", secured_xml)
        self.assertIn("{{concurrency-limit-open}}", secured_xml)
        self.assertIn('buffer-response="false"', secured_xml)

        public_xml = (ROOT / "policies/operation-public.xml").read_text(encoding="utf-8")
        self.assertIn("Acceso anónimo deshabilitado", public_xml)
        self.assertIn("SCOPE_INSUFICIENTE", public_xml)
        self.assertNotIn("context.Request.IpAddress", public_xml)
        self.assertNotIn("X-Forwarded-For", public_xml)
        self.assertNotIn("X-Real-IP", public_xml)

        bicep_text = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("param reuseExistingApim bool", bicep_text)
        self.assertIn("param environmentTier string", bicep_text)
        self.assertIn("param rateProfiles object\n", bicep_text)
        self.assertIn("var fixedFilteredOpenApiObject = loadJsonContent('./openapi/gateway-filtered.compact.json')", bicep_text)
        self.assertIn("var fixedFilteredOpenApi = string(fixedFilteredOpenApiObject)", bicep_text)
        self.assertNotIn("loadTextContent('./openapi/gateway-filtered.json')", bicep_text)
        self.assertNotIn("param filteredOpenApi string", bicep_text)
        self.assertIn("var publicationGatePassed", bicep_text)
        self.assertIn("var authorizedOperations", bicep_text)
        self.assertNotIn("requireEffectivePublication", bicep_text)
        self.assertIn("bytes: 0", bicep_text)

        compact_text = (ROOT / "openapi/gateway-filtered.compact.json").read_text(encoding="utf-8")
        self.assertLessEqual(len(compact_text), FILTER.BICEP_LOAD_JSON_MAX_CHARS)
        self.assertEqual(
            FILTER.canonical_sha256(json.loads(compact_text)),
            FILTER.canonical_sha256(json.loads((ROOT / "openapi/gateway-filtered.json").read_text(encoding="utf-8"))),
        )

    def test_aca_network_evidence_allow_only_and_internal_modes(self):
        expected_cidrs = ["20.10.20.30/32"]
        # Modalidad A: external=false con vnetConfiguration
        PARAMS.validate_aca_network_evidence(
            {"external": False, "directRoutesBlocked": True},
            {"vnetConfiguration": {"infrastructureSubnetId": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s"}},
            expected_cidrs,
        )
        # Modalidad B: external=true con reglas exclusivamente Allow hacia APIM
        PARAMS.validate_aca_network_evidence(
            {
                "external": True,
                "ipSecurityRestrictions": [{"action": "Allow", "ipAddressRange": "20.10.20.30/32"}],
                "directRoutesBlocked": True,
            },
            {"vnetConfiguration": None},
            expected_cidrs,
        )
        # Negativo: mezcla Allow y Deny (inválida en ACA)
        with self.assertRaisesRegex(ValueError, "mezclar reglas Allow y Deny"):
            PARAMS.validate_aca_network_evidence(
                {
                    "external": True,
                    "ipSecurityRestrictions": [
                        {"action": "Allow", "ipAddressRange": "20.10.20.30/32"},
                        {"action": "Deny", "ipAddressRange": "0.0.0.0/0"},
                    ],
                    "directRoutesBlocked": True,
                },
                {"vnetConfiguration": None},
                expected_cidrs,
            )
        # Negativo: wildcard 0.0.0.0/0 en Allow
        with self.assertRaisesRegex(ValueError, "abiertos"):
            PARAMS.validate_aca_network_evidence(
                {
                    "external": True,
                    "ipSecurityRestrictions": [{"action": "Allow", "ipAddressRange": "0.0.0.0/0"}],
                    "directRoutesBlocked": True,
                },
                {"vnetConfiguration": None},
                expected_cidrs,
            )
        # Negativo: CIDR fuera de APIM autorizado
        with self.assertRaisesRegex(ValueError, "expectedApimOriginCidrs"):
            PARAMS.validate_aca_network_evidence(
                {
                    "external": True,
                    "ipSecurityRestrictions": [{"action": "Allow", "ipAddressRange": "198.51.100.10/32"}],
                    "directRoutesBlocked": True,
                },
                {"vnetConfiguration": None},
                expected_cidrs,
            )

    def test_two_stage_deployment_infrastructure_vs_effective(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory(prefix="apim-two-stage-") as temp_dir:
            evidence_path = Path(temp_dir) / "cli-evidence.json"
            evidence_path.write_text(
                json.dumps(
                    {
                        "subscriptionId": "00000000-0000-0000-0000-000000000000",
                        "resourceGroup": "rg-g6-aca-chile",
                        "environment": "env-g6-phase1-chile",
                        "capturedAtUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "sourceCommand": "az containerapp show -g rg-g6-aca-chile -n api-gateway",
                        "acaEnvironment": {"vnetConfiguration": None},
                        "gatewayApp": {
                            "resourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/api-gateway",
                            "external": True,
                            "ipSecurityRestrictions": [],
                            "directRoutesBlocked": False,
                        },
                    }
                ),
                encoding="utf-8",
            )
            filtered = json.loads((ROOT / "openapi" / "gateway-filtered.json").read_text(encoding="utf-8"))
            manifest = json.loads((ROOT / "openapi" / "operation-security.json").read_text(encoding="utf-8"))
            base_params = {
                "deploymentStage": "infrastructure",
                "candidateApiName": "g6-h5-candidate",
                "candidateApiPath": "h5-candidate/api/v1",
                "environmentTier": "lab",
                "expectedSubscriptionId": "00000000-0000-0000-0000-000000000000",
                "expectedResourceGroup": "rg-g6-aca-chile",
                "expectedEnvironment": "env-g6-phase1-chile",
                "expectedGatewayResourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/api-gateway",
                "apimSubnetResourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-g6-productos-azure/providers/Microsoft.Network/virtualNetworks/vm-g6-backendVNET/subnets/snet-g6-apim",
                "gatewayBackendUrl": "https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1",
                "azureCliEvidencePath": str(evidence_path),
                "operationalApprovalRef": "APROBACION-INFRA-H5",
                "g7Issuer": "https://g7-auth-service.onrender.com/api/v1/auth",
                "g7OpenIdConfigurationUrl": "https://g7-auth-service.onrender.com/api/v1/auth/.well-known/openid-configuration",
                "g7Audience": "api-productos",
                "corsAllowedOrigins": ["https://marketplace.example.com"],
                "burstCalls": 60,
                "burstWindowSeconds": 60,
                "quotaCalls": 1000,
                "quotaWindowSeconds": 3600,
                "rateProfiles": {
                    name: {"burstCalls": 60, "burstWindowSeconds": 60, "quotaCalls": 1000, "quotaWindowSeconds": 3600, "maxConcurrency": 0}
                    for name in FILTER.KNOWN_RATE_PROFILES
                },
                "applicationInsightsResourceId": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-g6-aca-chile/providers/Microsoft.Insights/components/appi-g6-apim-chile",
                "applicationInsightsConnectionString": "InstrumentationKey=00000000-0000-0000-0000-000000000000",
                "expectedOperationSetSha256": manifest["operationSetSha256"],
                "expectedFilteredOpenApiSha256": manifest["filteredOpenApiCanonicalSha256"],
            }
            # Etapa A (infrastructure): pasa sin directRoutesBlocked ni manifest effective
            PARAMS.validate(
                base_params,
                filtered,
                manifest,
                expected_docs_sha=manifest["docsSha"],
                expected_gateway_sha=manifest["gatewaySha"],
            )
            # Etapa B (effective): sigue bloqueando si manifest es candidate o falta directRoutesBlocked
            effective_params = dict(base_params, deploymentStage="effective", expectedApimOriginCidrs=["20.10.20.30/32"])
            with self.assertRaisesRegex(ValueError, "Publicación efectiva bloqueada"):
                PARAMS.validate(
                    effective_params,
                    filtered,
                    manifest,
                    expected_docs_sha=manifest["docsSha"],
                    expected_gateway_sha=manifest["gatewaySha"],
                )


if __name__ == "__main__":
    unittest.main()
