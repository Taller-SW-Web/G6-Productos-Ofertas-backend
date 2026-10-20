from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from scripts import validate_marketplace_h4_docs as validator


REAL_DOCS = validator.resolve_docs_dir(root=validator.ROOT)


def minimal_spec() -> dict:
    paths: dict = {}
    for operation_id, (method, full_path) in validator.G6_OPERATIONS.items():
        path = full_path.removeprefix("/api/v1")
        paths.setdefault(path, {})[method.lower()] = {
            "operationId": operation_id,
            "x-required-scope": {
                "listarCategorias": "catalogo:leer", "listarProductos": "catalogo:leer",
                "obtenerProductoPorSlug": "catalogo:leer", "consultarPrecios": "precios:leer",
                "obtenerPrecioSku": "precios:leer", "consultarDisponibilidadComercial": "inventario:disponibilidad:leer",
                "verificarCantidadComercial": "inventario:disponibilidad:leer", "evaluarPromociones": "promociones:evaluar",
                "validarCupon": "cupones:validar", "obtenerRecomendaciones": "recomendaciones:leer",
            }[operation_id],
            "x-allowed-client-ids": ["modulo-marketplace", "modulo-chatbot", "modulo-retail"],
            "security": [{"serviceBearer": []}],
        }
    return {
        "openapi": "3.0.3", "servers": [{"url": "/api/v1"}], "paths": paths,
        "x-security-contract": {"service_scopes_pending_registration": {
            "recomendaciones:leer": {"clients": ["modulo-chatbot"]}
        }},
    }


class ValidatorTests(unittest.TestCase):
    def make_docs(self, parent: Path, spec: dict | None = None) -> Path:
        docs = parent / "docs"
        (docs / validator.OPENAPI_REL.parent).mkdir(parents=True)
        (docs / validator.AGREEMENT_REL.parent).mkdir(parents=True)
        if spec is None:
            spec = minimal_spec()
        (docs / validator.OPENAPI_REL).write_text(yaml.safe_dump(spec, sort_keys=False), encoding="utf-8")
        (docs / validator.AGREEMENT_REL).write_text(
            "\n".join(f"| M-{n:02d} | `ACEPTADO_G6_COMUNICADO_G1` |" for n in range(1, 10)), encoding="utf-8"
        )
        return docs

    def test_cli_path_has_priority(self):
        with tempfile.TemporaryDirectory() as temp:
            cli = self.make_docs(Path(temp) / "cli")
            env = self.make_docs(Path(temp) / "env")
            self.assertEqual(validator.resolve_docs_dir(cli, {"G6_DOCS_DIR": str(env)}, Path(temp) / "backend"), cli.resolve())

    def test_environment_path(self):
        with tempfile.TemporaryDirectory() as temp:
            env = self.make_docs(Path(temp))
            self.assertEqual(validator.resolve_docs_dir(None, {"G6_DOCS_DIR": str(env)}, Path(temp) / "backend"), env.resolve())

    def test_conventional_sibling_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "backend"
            root.mkdir()
            docs = self.make_docs(Path(temp))
            self.assertEqual(validator.resolve_docs_dir(None, {}, root), docs.resolve())

    def test_docs_absent(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertIsNone(validator.resolve_docs_dir(None, {}, Path(temp) / "backend"))

    def test_wrong_http_method_or_path_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            spec = minimal_spec()
            op = spec["paths"]["/categorias"]["get"]
            spec["paths"]["/categorias"]["get"] = {"summary": "moved"}
            op["operationId"] = "listarCategorias"
            spec["paths"]["/wrong"] = {"post": op}
            docs = self.make_docs(Path(temp), spec)
            errors = validator.validate(docs)
            self.assertTrue(any("listarCategorias: método/ruta OpenAPI" in error for error in errors), errors)

    def test_wrong_scope_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            spec = minimal_spec()
            spec["paths"]["/categorias"]["get"]["x-required-scope"] = "scope:incorrecto"
            docs = self.make_docs(Path(temp), spec)
            self.assertTrue(any("scope:incorrecto" in error for error in validator.validate(docs)))

    def test_g5_operation_is_not_searched_as_g6(self):
        errors = validator.validate(REAL_DOCS)
        self.assertFalse(any("crearPedido" in error and "OpenAPI" in error for error in errors), errors)

    def test_missing_or_duplicate_function_fails(self):
        original = validator.MATRIX.read_text(encoding="utf-8")
        rows = [line for line in original.splitlines() if line.startswith("| F-")]
        with tempfile.TemporaryDirectory() as temp:
            matrix = Path(temp) / "matrix.md"
            matrix.write_text(original.replace(rows[0] + "\n", "", 1), encoding="utf-8")
            self.assertTrue(any("Función ausente: F-006" in e for e in validator.validate(REAL_DOCS, matrix)))
            matrix.write_text(original + "\n" + rows[0], encoding="utf-8")
            self.assertTrue(any("Función duplicada: F-006" in e for e in validator.validate(REAL_DOCS, matrix)))


if __name__ == "__main__":
    unittest.main()
