# Operación vigente Azure H5

La ruta operativa vigente de publicación y despliegue usa Azure Container Apps H5 y se documenta en [`container-apps/README.md`](container-apps/README.md). El flujo conserva validación del SHA exacto de `master`, CI exitosa, auditoría de dependencias, publicación GHCR inmutable, gates del environment, OIDC, despliegue, smoke y recuperación por digest.

La mensajería interna H5 usa Azure Service Bus Basic. El piloto Pricing → Price Audit tiene alcance parcial y evidencia propia en [`service-bus/CLOUD_PILOT.md`](service-bus/CLOUD_PILOT.md); no demuestra una migración funcional general, producción, grants G7 ni homologación externa.

La infraestructura Oracle/VM y Compose fue retirada del carril operativo. Los documentos históricos y los contratos H4 se conservan en el repositorio de Docs; no ejecutar sus procedimientos como despliegues vigentes. Esta retirada no cambia seguridad, identidad G7, APIM, contratos, handlers ni migraciones.
