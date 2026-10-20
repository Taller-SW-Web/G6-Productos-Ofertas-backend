from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from scripts import validate_marketplace_h4_docs as validator


SCOPES = {
    "listarCategorias": "catalogo:leer",
    "listarProductos": "catalogo:leer",
    "obtenerProductoPorSlug": "catalogo:leer",
    "consultarPrecios": "precios:leer",
    "obtenerPrecioSku": "precios:leer",
    "consultarDisponibilidadComercial": "inventario:disponibilidad:leer",
    "verificarCantidadComercial": "inventario:disponibilidad:leer",
    "evaluarPromociones": "promociones:evaluar",
    "validarCupon": "cupones:validar",
    "obtenerRecomendaciones": "recomendaciones:leer",
}
FUNCTION_OPERATIONS = {
    "F-006": ("listarCategorias", "listarProductos"),
    "F-007": ("listarProductos",),
    "F-008": ("listarProductos", "consultarPrecios"),
    "F-009": ("listarProductos",),
    "F-010": ("listarProductos",),
    "F-011": ("obtenerProductoPorSlug",),
    "F-012": ("consultarPrecios", "obtenerPrecioSku"),
    "F-013": ("obtenerProductoPorSlug",),
    "F-014": ("consultarDisponibilidadComercial",),
    "F-015": ("obtenerRecomendaciones",),
    "F-016": ("verificarCantidadComercial",),
    "F-017": ("verificarCantidadComercial",),
    "F-018": (),
    "F-019": ("listarProductos", "consultarPrecios", "consultarDisponibilidadComercial"),
    "F-020": ("obtenerProductoPorSlug", "consultarPrecios", "obtenerPrecioSku", "verificarCantidadComercial"),
    "F-021": ("obtenerProductoPorSlug",),
    "F-023": tuple(validator.G6_OPERATIONS),
    "F-024": ("evaluarPromociones", "validarCupon"),
    "F-025": ("verificarCantidadComercial", "consultarPrecios", "obtenerPrecioSku", "obtenerProductoPorSlug", "evaluarPromociones"),
    "F-026": (),
    "F-031": ("obtenerProductoPorSlug", "consultarPrecios", "obtenerPrecioSku", "consultarDisponibilidadComercial", "verificarCantidadComercial"),
    "F-036": ("obtenerProductoPorSlug", "listarProductos"),
    "F-037": ("obtenerProductoPorSlug", "consultarPrecios", "obtenerPrecioSku", "consultarDisponibilidadComercial"),
    "F-038": (),
    "F-039": ("obtenerProductoPorSlug", "consultarPrecios", "obtenerPrecioSku", "verificarCantidadComercial"),
}


def fixture_spec() -> dict:
    paths: dict = {}
    for operation_id, (method, full_path) in validator.G6_OPERATIONS.items():
        path = full_path.removeprefix("/api/v1")
        paths.setdefault(path, {})[method.lower()] = {
            "operationId": operation_id,
            "x-required-scope": SCOPES[operation_id],
            "x-allowed-client-ids": ["modulo-marketplace", "modulo-chatbot", "modulo-retail"],
            "security": [{"serviceBearer": []}],
        }
    return {
        "openapi": "3.0.3",
        "servers": [{"url": "/api/v1"}],
        "paths": paths,
        "x-security-contract": {"service_scopes_pending_registration": {
            "recomendaciones:leer": {"clients": ["modulo-chatbot"]}
        }},
    }


def fixture_matrix() -> str:
    header = "| Función G1 | Acuerdo | operationId G6 / externo | Endpoint G6 / externo | Servicio G6 owner | Responsable G6 | Consumidor/owner funcional | Scopes G6 | DTO / resultado | Estado contrato | Rama / PR | SHA_CODIGO_AUDITADO | SHA_CI_VERIFICADO | SHA_DOCUMENTAL_ACTUAL | SHA_DESPLEGADO | Implementación | CI | Despliegue | Grant G7 | Provider / Consumer | E2E | Bloqueo específico | Criterio verificable de cierre |"
    separator = "|" + "---|" * 23
    lines = [header, separator]
    for function in validator.EXPECTED:
        operation_ids = FUNCTION_OPERATIONS[function]
        operations = "; ".join(f"`{operation_id}`" for operation_id in operation_ids) or "NO_APLICA_G6_DIRECTO"
        endpoints = "; ".join(f"{validator.G6_OPERATIONS[operation_id][0]} `{validator.G6_OPERATIONS[operation_id][1]}`" for operation_id in operation_ids) or "NO_APLICA_G6_DIRECTO"
        scopes = "; ".join(dict.fromkeys(SCOPES[operation_id] for operation_id in operation_ids)) or "NO_APLICA_G6_DIRECTO"
        function_cell = function + (" Crear pedido" if function == "F-026" else " Ejemplo")
        if function == "F-026":
            operations = "G5 `crearPedido`; NO_APLICA_G6_DIRECTO"
            endpoints = "G5 `POST /api/v1/pedidos`; NO_APLICA_G6_DIRECTO"
            implementation = "G5 crea pedido; G1 ejecuta experiencia y orquestación BFF; G6 no expone endpoint de crear pedido; `CREADO` != `PAGADO`"
        else:
            implementation = "Documentado"
        cells = [function_cell, "M-09", operations, endpoints, "G6/G1", "Owner", "G1", scopes,
                 "Resultado", "Definido", "castilla", "SHA", "SHA", "SHA", "NO_VERIFICADO",
                 implementation, "NO_VERIFICADO", "NO_VERIFICADO", "NO_VERIFICADO", "Provider/Consumer",
                 "NO_VERIFICADO", "Pendiente específico", "Criterio"]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.docs = self.root / "docs"
        (self.docs / validator.OPENAPI_REL.parent).mkdir(parents=True)
        (self.docs / validator.AGREEMENT_REL.parent).mkdir(parents=True)
        self.write_spec(fixture_spec())
        agreement = "\n".join(f"| M-{n:02d} | `ACEPTADO_G6_COMUNICADO_G1` |" for n in range(1, 10))
        (self.docs / validator.AGREEMENT_REL).write_text(agreement, encoding="utf-8")
        self.matrix = self.root / "MATRIZ_OPERACIONES_H4.md"
        self.matrix.write_text(fixture_matrix(), encoding="utf-8")

    def write_spec(self, spec: dict):
        (self.docs / validator.OPENAPI_REL).write_text(yaml.safe_dump(spec, sort_keys=False), encoding="utf-8")

    def rows(self):
        return validator.parse_matrix(self.matrix.read_text(encoding="utf-8"))

    def write_rows(self, rows):
        self.matrix.write_text("| h |\n|---|\n" + "\n".join("| " + " | ".join(row) + " |" for row in rows) + "\n", encoding="utf-8")

    def row(self, function):
        return next(row for row in self.rows() if row[0].startswith(function))

    def test_cli_path_has_priority(self):
        fallback = self.root / "fallback"
        fallback.mkdir()
        self.assertEqual(validator.resolve_docs_dir(self.docs, {"G6_DOCS_DIR": str(fallback)}, self.root / "backend"), self.docs.resolve())

    def test_environment_path(self):
        self.assertEqual(validator.resolve_docs_dir(None, {"G6_DOCS_DIR": str(self.docs)}, self.root / "backend"), self.docs.resolve())

    def test_conventional_sibling_path(self):
        root = self.root / "backend"
        root.mkdir()
        (self.root / "docs").mkdir(exist_ok=True)
        for required in (validator.OPENAPI_REL, validator.AGREEMENT_REL):
            target = self.root / "docs" / required
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        self.assertEqual(validator.resolve_docs_dir(None, {}, root), (self.root / "docs").resolve())

    def test_docs_absent(self):
        absent_root = self.root / "absent" / "backend"
        absent_root.mkdir(parents=True)
        self.assertIsNone(validator.resolve_docs_dir(None, {}, absent_root))

    def test_operation_id_with_wrong_contract_method_or_path_fails(self):
        spec = fixture_spec()
        op = spec["paths"]["/categorias"].pop("get")
        spec["paths"]["/wrong"] = {"post": op}
        self.write_spec(spec)
        errors = validator.validate(self.docs, self.matrix)
        self.assertTrue(any("listarCategorias: método/ruta OpenAPI" in error for error in errors), errors)

    def test_wrong_scope_in_openapi_fails(self):
        spec = fixture_spec()
        spec["paths"]["/categorias"]["get"]["x-required-scope"] = "scope:incorrecto"
        self.write_spec(spec)
        self.assertTrue(any("scope:incorrecto" in error for error in validator.validate(self.docs, self.matrix)))

    def test_g5_operation_is_not_searched_as_g6(self):
        self.assertEqual(validator.validate(self.docs, self.matrix), [])

    def test_missing_or_duplicate_function_fails(self):
        rows = self.rows()
        self.write_rows(rows[1:])
        self.assertTrue(any("Función ausente: F-006" in error for error in validator.validate(self.docs, self.matrix)))
        self.write_rows(rows + [rows[0]])
        self.assertTrue(any("Función duplicada: F-006" in error for error in validator.validate(self.docs, self.matrix)))

    def test_wrong_endpoint_path_in_matrix_fails(self):
        rows = self.rows()
        target = next(row for row in rows if row[0].startswith("F-006"))
        target[3] = target[3].replace("/api/v1/categorias", "/api/v1/categorias-incorrecta")
        self.write_rows(rows)
        self.assertTrue(any("Endpoint no documenta GET `/api/v1/categorias`" in error for error in validator.validate(self.docs, self.matrix)))

    def test_wrong_endpoint_method_in_matrix_fails(self):
        rows = self.rows()
        target = next(row for row in rows if row[0].startswith("F-006"))
        target[3] = target[3].replace("GET `/api/v1/categorias`", "POST `/api/v1/categorias`")
        self.write_rows(rows)
        self.assertTrue(any("Endpoint no documenta GET `/api/v1/categorias`" in error for error in validator.validate(self.docs, self.matrix)))

    def test_generic_scope_for_operation_fails(self):
        rows = self.rows()
        target = next(row for row in rows if row[0].startswith("F-006"))
        target[7] = "Scopes por operación"
        self.write_rows(rows)
        self.assertTrue(any("no registra scope catalogo:leer" in error for error in validator.validate(self.docs, self.matrix)))

    def test_f026_cannot_assign_order_creation_to_g6(self):
        rows = self.rows()
        target = next(row for row in rows if row[0].startswith("F-026"))
        target[15] = "G5 crea pedido; G6 crea pedido"
        self.write_rows(rows)
        self.assertTrue(any("F-026 debe atribuir crear pedido a G5 y no a G6" in error for error in validator.validate(self.docs, self.matrix)))

    def test_security_rejects_unauthenticated_alternative(self):
        spec = fixture_spec()
        spec["paths"]["/categorias"]["get"]["security"].append({})
        self.write_spec(spec)
        self.assertTrue(any("alguna alternativa de security efectiva permite omitir serviceBearer" in error for error in validator.validate(self.docs, self.matrix)))


if __name__ == "__main__":
    unittest.main()
