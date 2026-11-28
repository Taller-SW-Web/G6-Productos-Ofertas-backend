# Evidencia local

Cada invocación guarda `summary.json`, `summary.sha256` y, si hay métricas, `metrics.csv` bajo `.local/<id>/`. `runtime.json` y `dashboard.html` son artefactos internos de diagnóstico. Revisa el resumen antes de compartir y conserva archivos crudos localmente con acceso restringido. `.local/` está ignorado por Git.

El resumen contiene caso, operación, alcance, ventana medida UTC, perfil, repetición, SHAs, hashes de fuentes, versión k6, dataset, revisión, digest del sujeto y hash del permiso (staging). Distingue techo RPS configurado, intentos ofrecidos por segundo y 2xx válidos conseguidos por segundo. La negativa HTTP tiene su propio contador. La cercanía al techo del cliente deja el gate de RPS sin evaluar. El dashboard puede incluir preparación y cierre.

Para P3, guarda en el directorio `-Telemetria` dos entradas por corrida.

- `<sha256-del-summary>.json` contiene `summary_sha256` y `telemetry_sha256`.
- `<sha256-telemetria>.artifact.json` contiene los bytes del export original de telemetría normalizada, no solo un índice. Además de `schema_version: 1` y `summary_sha256`, incluye sujeto, revisión, digest, SHA Backend, entorno, caso y perfil (`subject`, `revision`, `subject_digest`, `backend_sha`, `environment`, `case_id`, `profile`). Incluye `interval_start_utc`, `interval_end_utc`, `warmup_seconds`, `cpu_peak_pct`, `memory_peak_mb` y `db_connections_peak`.

El comparador calcula el hash del archivo original y verifica la vinculación con la corrida y el sujeto. El intervalo debe cubrir toda la medición y puede excederla hasta 15 segundos por extremo para tolerar el muestreo. Se rechazan entradas alteradas, incompletas, de otra revisión o de otra ventana. El equipo debe conservar el export original de su recolector y validar su origen. Mantén fuera de Git hostnames, credenciales y cuerpos de respuesta.

Los resúmenes L1 publicados en `local/` se guardan con LF y UTF-8 sin BOM para conservar sus SHA-256 en Windows y Linux. Verifícalos con `node scripts/h5/k6/tests/verificar-evidencia.mjs` desde la raíz de Backend.

Estados de ejecución. `PASS`, corrida completa con métricas y gates de ejecución satisfechos. `FAIL`, fallo explícito de k6. `INCONCLUSIVE`, evidencia incompleta o no comparable. `NOT_RUN`/`NO_EJECUTADO`, sin medición. El scope local `L1_FIXTURE_SINTETICO` no se admite como entrada para una comparación formal.
