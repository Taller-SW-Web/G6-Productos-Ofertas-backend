#!/usr/bin/env bash
set -Eeuo pipefail

# Shim para conservar el destino SSH instalado por el PR #7. El ejecutor y
# el registro se instalan primero; este archivo reemplaza el anterior al final.
exec /usr/local/lib/g6-productos-ofertas/deploy-g6-service "$@"
