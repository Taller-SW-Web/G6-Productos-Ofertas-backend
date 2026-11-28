# Azure Container Apps H5

El CD candidato está documentado en [CONFIGURACION_OIDC_H5.md](CONFIGURACION_OIDC_H5.md). El único trigger es manual (`workflow_dispatch`) desde `master`; exige el HEAD exacto vigente, CI exacta y auditoría de dependencias limpia antes de publicar. `prepare` valida `azure-h5` antes de GHCR y `deploy` repite la consulta justo antes de OIDC. El environment aún no está verificado: el owner debe configurar reviewers, restricción exclusiva a `master` y prevención de autoaprobación.

El flujo contempla los nueve servicios. La opción `all` es manual y secuencial. Antes de actualizar comprueba el recurso ACA y conserva la configuración del resto de contenedores; Gateway conserva Caddy. Cada cambio registra recibo y el rollback supervisado comprueba que no haya drift o concurrencia. El smoke obligatorio corre en el runner privado `azure-h5-smoke` y falla si falta URL/ruta o el servicio no responde como exige el contrato.

El CD reintenta las lecturas de Azure ARM ante fallos transitorios como HTTP 503 o un reset de conexión. El límite es de cuatro intentos con espera exponencial y variación aleatoria. Si falla la lectura del tráfico previo de una revisión en modo Multiple, el CD informa que no pudo verificarla y cancela el despliegue. Las escrituras conservan la verificación y la recuperación supervisada del flujo.

Las pruebas locales usan dobles de Azure CLI; no prueban una suscripción real. No se afirma integración autenticada, smoke funcional, homologación ni despliegue sin evidencia remota ligada al SHA/digest.
