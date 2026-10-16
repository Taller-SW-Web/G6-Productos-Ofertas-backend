#!/usr/bin/env bash
set -Eeuo pipefail

# Mantiene el punto de entrada histórico de pruebas mientras la cobertura de
# despliegue se comparte con los nueve servicios.
readonly TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${TEST_DIR}/deploy-g6-service.test.sh"
