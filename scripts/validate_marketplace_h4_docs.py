#!/usr/bin/env python3
"""Validate the G1 H4 matrix against the canonical Docs OpenAPI."""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - depends on runtime environment
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md"
AGREEMENT_REL = Path("integraciones/ACUERDO_G1_G6_H4_2026-10-20.md")
OPENAPI_REL = Path("contratos/http/openapi.yaml")
EXPECTED = [f"F-{n:03d}" for n in (6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,23,24,25,26,31,36,37,38,39)]
EXTERNAL_OPERATION_IDS = {"crearPedido"}
METHODS = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}

# These are operation correspondences stated in the H4 matrix and its normative
# contract. They deliberately exclude BFF, G2 and G5 routes.
G6_OPERATIONS = {
    "listarCategorias": ("GET", "/api/v1/categorias"),
    "listarProductos": ("GET", "/api/v1/productos"),
    "obtenerProductoPorSlug": ("GET", "/api/v1/productos/por-slug/{slug}"),
    "consultarPrecios": ("GET", "/api/v1/precios"),
    "obtenerPrecioSku": ("GET", "/api/v1/precios/skus/{sku}"),
    "consultarDisponibilidadComercial": ("GET", "/api/v1/inventario/disponibilidad/comercial"),
    "verificarCantidadComercial": ("POST", "/api/v1/inventario/disponibilidad/comercial/verificar"),
    "evaluarPromociones": ("POST", "/api/v1/promociones/evaluar"),
    "validarCupon": ("POST", "/api/v1/cupones/validar"),
    "obtenerRecomendaciones": ("GET", "/api/v1/recomendaciones"),
}


def valid_docs_dir(path: Path) -> bool:
    return (path / OPENAPI_REL).is_file() and (path / AGREEMENT_REL).is_file()


def resolve_docs_dir(cli_docs_dir: str | Path | None = None, env: dict[str, str] | None = None,
                     root: Path = ROOT) -> Path | None:
    """Pick the first valid source in CLI, env, conventional sibling order."""
    env = os.environ if env is None else env
    candidates: list[Path] = []
    if cli_docs_dir:
        candidates.append(Path(cli_docs_dir).expanduser())
    if env.get("G6_DOCS_DIR"):
        candidates.append(Path(env["G6_DOCS_DIR"]).expanduser())
    candidates.extend(root.parent / name for name in ("docs", "G6-Productos-Ofertas-docs", "docs-g1-h4"))
    for candidate in candidates:
        resolved = candidate.resolve()
        if valid_docs_dir(resolved):
            return resolved
    return None


def parse_matrix(text: str) -> list[list[str]]:
    lines = [line for line in text.splitlines() if re.match(r"\|\s*F-\d+\b", line)]
    return [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in lines]


def operation_index(spec: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    base = (spec.get("servers") or [{}])[0].get("url", "").rstrip("/")
    paths = spec.get("paths") or {}
    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method.lower() not in METHODS or not isinstance(operation, dict):
                continue
            operation_id = operation.get("operationId")
            if not operation_id:
                continue
            security = operation.get("security", spec.get("security", []))
            result[operation_id] = {
                "method": method.upper(), "path": f"{base}{path}",
                "scope": operation.get("x-required-scope"),
                "clients": operation.get("x-allowed-client-ids"),
                "security": security,
            }
    return result


def has_effective_service_bearer(security: Any) -> bool:
    """OpenAPI security requirements are OR alternatives; schemes within one are AND."""
    return (
        isinstance(security, list)
        and bool(security)
        and all(isinstance(alternative, dict) and "serviceBearer" in alternative for alternative in security)
    )


def validate(docs_dir: Path, matrix_path: Path = MATRIX) -> list[str]:
    errors: list[str] = []
    matrix_text = matrix_path.read_text(encoding="utf-8")
    rows = parse_matrix(matrix_text)
    ids = [re.match(r"(F-\d+)\b", row[0]).group(1) if re.match(r"(F-\d+)\b", row[0]) else "" for row in rows]
    if ids != EXPECTED:
        for function in EXPECTED:
            if ids.count(function) == 0:
                errors.append(f"Función ausente: {function}")
            elif ids.count(function) > 1:
                errors.append(f"Función duplicada: {function}")
        if not errors:
            errors.append(f"Funciones fuera de orden o no permitidas: {ids}")
    if any(len(row) != 23 for row in rows):
        errors.append("Una o más filas no conservan las 23 columnas")
    by_id = {function: row for function, row in zip(ids, rows)}
    for function, operation_ids in {
        "F-006": ("listarCategorias", "listarProductos"),
        "F-024": ("evaluarPromociones", "validarCupon"),
        "F-025": ("verificarCantidadComercial",),
    }.items():
        row = by_id.get(function, [])
        for operation_id in operation_ids:
            if len(row) < 3 or f"`{operation_id}`" not in row[2]:
                errors.append(f"{function} debe incluir {operation_id}")
    f026 = by_id.get("F-026", [])
    f026_text = " ".join(f026).lower()
    g6_claims_order = bool(re.search(
        r"\bg6\s+(?:crea|creará|crearía|es responsable de crear|está a cargo de crear)\s+pedido\b"
        r"|\b(?:crea|crear|creación de)\s+pedido\s+(?:pertenece|es responsabilidad de|es de)\s+g6\b",
        f026_text,
    ))
    if (
        len(f026) < 16
        or "g5 crea pedido" not in f026_text
        or g6_claims_order
        or "g1 ejecuta experiencia y orquestación bff" not in f026_text
        or "`creado` != `pagado`" not in f026_text
    ):
        errors.append("F-026 debe atribuir crear pedido a G5 y no a G6")

    if yaml is None:
        errors.append("Parser YAML no disponible (PyYAML); no se puede validar OpenAPI")
        return errors
    try:
        spec = yaml.safe_load((docs_dir / OPENAPI_REL).read_text(encoding="utf-8"))
        agreement = (docs_dir / AGREEMENT_REL).read_text(encoding="utf-8")
    except (OSError, yaml.YAMLError) as exc:
        return [f"No se pudieron leer OpenAPI/acuerdo: {exc}"]
    operations = operation_index(spec or {})
    for operation_id, (expected_method, expected_path) in G6_OPERATIONS.items():
        actual = operations.get(operation_id)
        if actual is None:
            errors.append(f"operationId G6 inexistente en OpenAPI: {operation_id}")
            continue
        if (actual["method"], actual["path"]) != (expected_method, expected_path):
            errors.append(f"{operation_id}: método/ruta OpenAPI {actual['method']} {actual['path']}, esperado {expected_method} {expected_path}")
        if not actual["scope"]:
            errors.append(f"{operation_id}: x-required-scope ausente")
        if not has_effective_service_bearer(actual["security"]):
            errors.append(f"{operation_id}: alguna alternativa de security efectiva permite omitir serviceBearer")
        if actual["clients"] is not None and "modulo-marketplace" not in actual["clients"]:
            errors.append(f"{operation_id}: allowlist no autoriza modulo-marketplace")

    for row in rows:
        if len(row) < 8:
            continue
        operation_ids = set(re.findall(r"\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b", row[2]))
        unknown = operation_ids - set(G6_OPERATIONS) - EXTERNAL_OPERATION_IDS
        if unknown:
            errors.append(f"operationId no reconocido en {row[0]}: {sorted(unknown)}")
        for operation_id in operation_ids & set(G6_OPERATIONS):
            actual = operations.get(operation_id)
            if not actual:
                continue
            endpoint_token = f"{actual['method']} `{actual['path']}`"
            if endpoint_token not in row[3]:
                errors.append(f"{row[0]} Endpoint no documenta {endpoint_token} para {operation_id}")
            if actual["scope"] and actual["scope"] not in row[7]:
                errors.append(f"{row[0]} no registra scope {actual['scope']} de {operation_id}")

    for n in range(1, 10):
        if not any(line.startswith(f"| M-{n:02d} ") and "`ACEPTADO_G6_COMUNICADO_G1`" in line for line in agreement.splitlines()):
            errors.append(f"Acuerdo M-{n:02d} no consta aceptado")
    security_contract = spec.get("x-security-contract", {})
    pending = security_contract.get("service_scopes_pending_registration", {}).get("recomendaciones:leer", {}).get("clients", [])
    recommendation_clients = operations.get("obtenerRecomendaciones", {}).get("clients") or []
    if set(recommendation_clients) != {"modulo-marketplace", "modulo-chatbot", "modulo-retail"}:
        errors.append("Allowlist real de obtenerRecomendaciones no contiene exactamente Marketplace, Chatbot y Retail")
    if pending != ["modulo-chatbot"]:
        errors.append(f"Registro pendiente recomendaciones:leer cambió; valor observado: {pending}")

    try:
        changed = subprocess.run(["git", "diff", "--name-only", "origin/master...HEAD"], cwd=ROOT,
                                 text=True, capture_output=True, check=True).stdout.splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        changed = []
    markdown = [ROOT / name for name in changed if name.lower().endswith(".md")] + [matrix_path]
    broken: list[str] = []
    for file in set(markdown):
        if not file.is_file():
            continue
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", file.read_text(encoding="utf-8")):
            target = target.strip().split(" ", 1)[0].strip("<>")
            if not target or target.startswith(("http://", "https://", "mailto:", "#", "data:")):
                continue
            path = target.split("#", 1)[0].split("?", 1)[0]
            if path and not (file.parent / path).exists() and not (file.parent / path.replace("/", "\\")).exists():
                broken.append(f"{file.relative_to(ROOT)} -> {target}")
    if broken:
        errors.append("Enlaces relativos rotos:\n" + "\n".join(sorted(broken)))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-dir", help="directorio raíz del repositorio Docs")
    args = parser.parse_args(argv)
    docs_dir = resolve_docs_dir(args.docs_dir)
    if docs_dir is None:
        print("NO_EJECUTADO: FUENTE_NO_DISPONIBLE. Proporcione la ruta del repositorio Docs con --docs-dir <ruta>.", file=sys.stderr)
        return 2
    errors = validate(docs_dir)
    if errors:
        print("FAIL: " + "\n".join(errors), file=sys.stderr)
        return 1
    print(f"PASS: {len(EXPECTED)} filas únicas; correspondencia operationId/método/ruta/scope/cliente OpenAPI válida; M-01–M-09 aceptados; discrepancy recomendaciones:leer registrada (sin inferir grant G7).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
