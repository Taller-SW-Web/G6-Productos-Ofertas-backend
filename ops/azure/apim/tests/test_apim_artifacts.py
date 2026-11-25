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
EXPECTED_DOCS_SHA = "490172c11cb4b83ddd1996f8d5834d0402184cf8"
EXPECTED_GATEWAY_SHA = "b0c41cb41e089cffb349da9c3938f8f62e793cd6"
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
            "applicationInsightsResourceId": "/subscriptions/test/resourceGroups/lab/providers/Microsoft.Insights/components/g6-h5-test",
            "applicationInsightsConnectionString": "test-placeholder-not-a-real-secret",
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
            {"applicationInsightsResourceId": "/subscriptions/test/resourceGroups/lab/providers/Microsoft.ApiManagement/service/apim/loggers/logger"},
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

    def test_application_insights_logger_uses_secure_connection_and_system_identity(self):
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("Microsoft.ApiManagement/service/loggers@2022-08-01", bicep)
        self.assertIn("parent: apim", bicep)
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
        self.assertIn("[for operation in operationsManifest.operations", bicep)
        self.assertIn("${operation.apimOperationId}/policy", bicep)

    def test_final_manifest_keeps_h5_operation_count_and_exclusions(self):
        manifest = json.loads((ROOT / "openapi" / "operation-security.json").read_text(encoding="utf-8"))
        operations = manifest["operations"]
        self.assertEqual(len(operations), 145)
        self.assertEqual(sum(operation["secured"] for operation in operations), 143)
        self.assertEqual(sum(not operation["secured"] for operation in operations), 2)
        self.assertEqual(len(manifest["privateOperationIds"]), 5)
        self.assertFalse(manifest["g5EnabledByDefault"])
        self.assertEqual(sum(operation["g5OptIn"] for operation in operations), 0)
        self.assertEqual(
            manifest["excludedUncontractedLegacyOperationIds"],
            sorted(FILTER.LEGACY_UNCONTRACTED),
        )

    def test_gateway_prefix_maps_public_route_without_rewrite(self):
        backend = "https://gateway.private.test/api/v1"
        public = "/api/v1/productos"
        self.assertEqual(PARAMS.gateway_path_for_public_request(backend, public), "/api/v1/productos")
        api_policy = (ROOT / "policies" / "api.xml").read_text(encoding="utf-8")
        self.assertNotIn("rewrite-uri", api_policy)
        bicep = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("path: 'api/v1'", bicep)


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
                )

    def test_compiled_arm_has_exact_hierarchical_policy_set_and_exclusions(self):
        self.assertEqual(
            ARM.validate(
                self.template,
                self.filtered,
                self.manifest,
                EXPECTED_DOCS_SHA,
                EXPECTED_GATEWAY_SHA,
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
        )
        self.assertTrue(manifest["effectivePublication"]["authorized"])
        self.assertEqual(manifest["effectivePublication"]["publishedOperationIds"], ["obtenerCombo"])
        self.assertEqual(set(filtered["paths"].keys()), {"/combo"})
        self.assertIn(
            {"operationId": "consultarDisponibilidadCombo", "reason": "PENDING_G7_ALLOWLIST"},
            manifest["effectivePublication"]["excludedOperations"],
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
        self.assertIn("context.Request.IpAddress", public_xml)
        self.assertIn('buffer-response="false"', public_xml)
        self.assertNotIn("X-Forwarded-For", public_xml)
        self.assertNotIn("X-Real-IP", public_xml)

        bicep_text = (ROOT / "main.bicep").read_text(encoding="utf-8")
        self.assertIn("param reuseExistingApim bool", bicep_text)
        self.assertIn("param environmentTier string", bicep_text)
        self.assertIn("param rateProfiles object\n", bicep_text)
        self.assertIn("var publicationGatePassed", bicep_text)
        self.assertIn("var authorizedOperations", bicep_text)
        self.assertIn("bytes: 0", bicep_text)


if __name__ == "__main__":
    unittest.main()
