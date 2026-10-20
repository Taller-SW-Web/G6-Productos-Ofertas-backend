#!/usr/bin/env python3
"""Static documental validator for the G1 Marketplace H4 matrix."""
from __future__ import annotations
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT.parent / "docs-g1-h4"
MATRIX = ROOT / "integraciones/g1-marketplace/MATRIZ_OPERACIONES_H4.md"
AGREEMENT = DOCS / "integraciones/ACUERDO_G1_G6_H4_2026-10-20.md"
OPENAPI = DOCS / "contratos/http/openapi.yaml"
EXPECTED = ["F-006","F-007","F-008","F-009","F-010","F-011","F-012","F-013","F-014","F-015","F-016","F-017","F-018","F-019","F-020","F-021","F-023","F-024","F-025","F-026","F-031","F-036","F-037","F-038","F-039"]
G6_OPERATION_IDS = {"listarCategorias","listarProductos","obtenerProductoPorSlug","consultarPrecios","obtenerPrecioSku","consultarDisponibilidadComercial","verificarCantidadComercial","evaluarPromociones","validarCupon","obtenerRecomendaciones"}
EXTERNAL_OPERATION_IDS = {"crearPedido"}

def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)

try:
    require(DOCS.is_dir() and OPENAPI.is_file(), "NO_EJECUTADO: FUENTE_NO_DISPONIBLE (Docs/OpenAPI canónico no accesible)")
    matrix = MATRIX.read_text(encoding="utf-8")
    lines = [line for line in matrix.splitlines() if line.startswith("| F-")]
    rows = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in lines]
    ids = [re.match(r"`?(F-\d+)\b", row[0]).group(1) if re.match(r"`?(F-\d+)\b", row[0]) else "" for row in rows]
    require(ids == EXPECTED, f"Funciones fuera de orden/duplicadas/ausentes: {ids}")
    require(all(len(row) == 23 for row in rows), "Una o más filas no conservan las 23 columnas")
    require("`listarCategorias`" in rows[0][2] and "`listarProductos`" in rows[0][2], "F-006 debe incluir Taxonomy y Catalog")
    require("`evaluarPromociones`" in rows[17][2] and "`validarCupon`" in rows[17][2], "F-024 debe incluir ambos operationIds")
    require("`verificarCantidadComercial`" in rows[18][2], "F-025 debe incluir verificarCantidadComercial")
    require("G5" in rows[19][2] and "`POST /api/v1/pedidos`" in rows[19][3] and "G6" in rows[19][4] and "G5 crea pedido; G6 no expone create-order" in rows[19][15], "F-026 no debe atribuir crear pedido a G6")
    openapi = OPENAPI.read_text(encoding="utf-8")
    for row in rows:
        candidates = set(re.findall(r"\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b", row[2]))
        require(candidates <= G6_OPERATION_IDS | EXTERNAL_OPERATION_IDS, f"operationId no autorizado o inventado en {row[0]}: {candidates - G6_OPERATION_IDS - EXTERNAL_OPERATION_IDS}")
        for operation in candidates & G6_OPERATION_IDS:
            require(re.search(r"\boperationId:\s*" + re.escape(operation) + r"\b", openapi), f"operationId G6 inexistente en OpenAPI: {operation}")
    for operation in G6_OPERATION_IDS:
        require(re.search(r"\boperationId:\s*" + re.escape(operation) + r"\b", openapi), f"operationId G6 inexistente en OpenAPI: {operation}")
    agreement = AGREEMENT.read_text(encoding="utf-8")
    for n in range(1, 10):
        require(any(line.startswith(f"| M-{n:02d} ") and "`ACEPTADO_G6_COMUNICADO_G1`" in line for line in agreement.splitlines()), f"Acuerdo M-{n:02d} no consta aceptado")
    changed = subprocess.run(["git","diff","--name-only","origin/master...HEAD"],cwd=ROOT,text=True,capture_output=True,check=True).stdout.splitlines()
    markdown = [ROOT / name for name in changed if name.lower().endswith(".md")]
    markdown += [MATRIX]
    broken=[]
    for file in sorted(set(markdown)):
        if not file.is_file():
            continue
        text=file.read_text(encoding="utf-8")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)",text):
            target=target.strip().split(" ",1)[0].strip("<>")
            if not target or target.startswith(("http://","https://","mailto:","#","data:")):
                continue
            path=target.split("#",1)[0].split("?",1)[0]
            if path and not (file.parent / path.replace("/", chr(92))).exists() and not (file.parent / path).exists():
                broken.append(f"{file.relative_to(ROOT)} -> {target}")
    require(not broken,"Enlaces relativos rotos:\n"+"\n".join(broken))
    print(f"PASS: {len(ids)} filas únicas; operación OpenAPI válida; M-01–M-09 aceptados; enlaces relativos válidos en {len(set(markdown))} Markdown.")
except Exception as exc:
    print(f"FAIL: {exc}",file=sys.stderr)
    sys.exit(1)
