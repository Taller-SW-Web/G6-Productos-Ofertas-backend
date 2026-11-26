# Certificación 158 Endpoints G6 H5 R2
- Fecha: 2026-11-26T22:29:56.096Z
- Total: 1 | PASS: 1 | FAIL: 0
- N01 Consume: COMPLETED | Bulk Terminal: COMPLETED | AuthChecks: true

| # | Servicio | operationId | Método | Ruta | HTTP | Seguridad | Negativo | Funcional | Persistencia | Async | Estado |
|---:|---|---|---|---|---:|---|---|---|---|---|---|
| 109 | bulk-svc | `reanudarImportacionGeneral` | POST | `/api/v1/carga-masiva/productos/importaciones/{batchId}/reanudar` | 202 | ROUTE_SECURITY_PASS | NEGATIVE_CONTRACT_PASS | FUNCTIONAL_PASS | PERSISTENCE_PASS | ASYNC_TERMINAL_PASS | **PASS** |