# Harness H5 de Castilla

Herramientas preparatorias offline para INT-04, PERF-07, APIM-01/02, INT-07,
PERF-08 y RL-01/02/04. No contienen hosts, grants ni identidades productivas.
El modo predeterminado es `--dry-run`; los modos de tráfico necesitan
`H5_LIVE_APPROVED=true`, una URL allowlisted y una identidad de ensayo declarada.

## Comandos

```powershell
node scripts/h5/castilla/generate-bulk-dataset.mjs --rows 1000 --seed h5-castilla-v1 --out $env:TEMP/bulk.csv
$env:H5_DOCS_ROOT = '<Docs worktree>'
node scripts/h5/castilla/verify-apim-static.mjs --docs-root $env:H5_DOCS_ROOT
node scripts/h5/castilla/run-http-scenarios.mjs --dry-run
node scripts/h5/castilla/run-rate-limit.mjs --dry-run
node scripts/h5/castilla/compare-perf08.mjs --dry-run
node scripts/h5/castilla/compare-perf08.mjs --fixture
node scripts/h5/castilla/run-rate-limit.mjs --fixture
```

## PERF-07 (ejecución futura, tras auditoría y autorización)

El generador usa exactamente `BULK_TEMPLATE_HEADERS` desde el código actual:

```powershell
node scripts/h5/castilla/generate-bulk-dataset.mjs --rows 1000 --seed release-x --unique-placeholder true --out $env:TEMP/bulk-1000.csv
$manifest = Get-Content "$env:TEMP/bulk-1000.csv.manifest.json" -Raw | ConvertFrom-Json
```

Usa `run-perf07.ps1` una vez por muestra con `-Target baseline|candidate`,
`-Profile 1vu-60s|5vu-3m|20vu-5m`, SHA, run UUID, archivo y directorio de salida.
Antes de **cada** muestra el operador restaura la DB descartable y marca
`H5_DATASET_RESTORED=true`; el runner no ejecuta SQL ni reinicia servicios.
Ejecuta 3 repeticiones pareadas por perfil. El manifest registra SHA de dataset;
las métricas del cliente distinguen 202/admisión y finalización durable. CPU/RAM
requieren adjuntar telemetría del runner/servicio. Timeout ambiguo solo consulta
correlación si el flag real está activado; nunca repite el POST.

Las URLs y secretos se suministran solo por entorno. No se imprime `Authorization`
ni el token. Los scripts generan resúmenes que distinguen admisión HTTP (202)
del resultado durable terminal. Timeout ambiguo conserva la misma clave de
operación: nunca crea otro POST automáticamente.

Los resultados contra fixtures/proxies locales son L0/L1. APIM real, G7,
telemetría de upstream, Service Bus Basic y homologación externa requieren sus
gates propios; estos harnesses no acreditan esos estados.
