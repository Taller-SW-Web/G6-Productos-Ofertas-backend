#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/artifacts"
target='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/taxonomy-svc@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
previous='ghcr.io/taller-sw-web/g6-productos-ofertas-backend/taxonomy-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
printf '%s\n' "$target" > "$TEMP/artifacts/image-taxonomy-svc.txt"
printf '%s\n' 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' > "$TEMP/artifacts/image-inventory-svc.txt"
printf '%s\n' 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/combos-svc@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' > "$TEMP/artifacts/image-combos-svc.txt"
printf '%s\n' 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/promotions-svc@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' > "$TEMP/artifacts/image-promotions-svc.txt"
jq -n --arg target "$target" --arg previous "$previous" '{service:"taxonomy-svc",destination:"brazil-isolated",github_environment:"azure-h5",resource_group:"rg-g6-sb-h5-int-fork",aca_environment:"env-g6-h5-int",location:"Brazil South",subscription_id:"fef42188-accd-4470-ae88-78f583eb4906",app_resource_id:"/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-sb-h5-int-fork/providers/Microsoft.App/containerApps/taxonomy-svc",container:"taxonomy-svc",previous:$previous,target:$target,config_sha256:"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' > "$TEMP/artifacts/taxonomy-svc.receipt"
jq -n --arg target "$(cat "$TEMP/artifacts/image-combos-svc.txt")" '{service:"combos-svc",destination:"chile-shared",github_environment:"azure-h5-chile",resource_group:"rg-g6-aca-chile",aca_environment:"env-g6-phase1-chile",location:"Chile Central",subscription_id:"fef42188-accd-4470-ae88-78f583eb4906",app_resource_id:"/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/combos-svc",container:"combos-svc",previous:"ghcr.io/taller-sw-web/g6-productos-ofertas-backend/combos-svc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",target:$target,config_sha256:"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' > "$TEMP/artifacts/combos-svc.receipt"

cat > "$TEMP/jobs.json" <<'JOBS'
{"jobs":[
 {"name":"Desplegar catalog-svc en Azure","conclusion":"skipped","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"skipped"}]},
 {"name":"Desplegar taxonomy-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]},
 {"name":"Desplegar inventory-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]},
 {"name":"Desplegar combos-svc en Azure","conclusion":"failure","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"failure"}]},
 {"name":"Desplegar promotions-svc en Azure","conclusion":"failure","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"failure"}]},
 {"name":"Desplegar price-audit-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]},
 {"name":"Desplegar bulk-svc en Azure","conclusion":"skipped","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"skipped"}]}
]}
JOBS

cat > "$TEMP/deploy-stub.sh" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == --restore ]]; then
  printf '%s\n' "$*" >> "${MOCK_DEPLOY_CALLS:?}"
  if [[ "$2" == taxonomy-svc ]]; then echo 'ROLLBACK COORDINADO VERIFICADO'; exit 0; fi
  echo 'RECUPERACIÓN OMITIDA: drift'; exit 1
fi
if [[ "$1" == --inspect ]]; then
  printf '%s\n' "$*" >> "${MOCK_DEPLOY_CALLS:?}"
  if [[ "$2" == inventory-svc ]]; then echo 'TARGET_ACTIVE: inventory-svc'; exit 0; fi
  if [[ "$2" == promotions-svc ]]; then echo 'TARGET_NOT_ACTIVE: promotions-svc'; exit 0; fi
  echo 'INSPECTION_UNKNOWN'; exit 2
fi
exit 2
STUB
[[ ! -x "$TEMP/deploy-stub.sh" ]] || { echo 'FAIL: recovery stub must have mode 100644/no execute bit' >&2; exit 1; }
: > "$TEMP/deploy-calls.log"

if DEPLOY_SCRIPT="$TEMP/deploy-stub.sh" MOCK_DEPLOY_CALLS="$TEMP/deploy-calls.log" GITHUB_STEP_SUMMARY="$TEMP/partial.md" bash "$ROOT/ops/azure/container-apps/reconcile-recovery.sh" \
  '["catalog-svc","taxonomy-svc","inventory-svc","combos-svc","promotions-svc","price-audit-svc","bulk-svc"]' "$TEMP/artifacts" "$TEMP/jobs.json" brazil-isolated azure-h5 > "$TEMP/partial.log" 2>&1; then
  echo 'FAIL: faltantes/desconocidos no pueden declarar recuperación completa' >&2
  exit 1
fi
for status in 'NO DESPLEGADO: catalog-svc' 'RECUPERADO: taxonomy-svc' 'ACTUALIZADO SIN RECIBO: inventory-svc' 'ESTADO DESCONOCIDO: combos-svc' 'ESTADO DESCONOCIDO: promotions-svc' 'ESTADO DESCONOCIDO: price-audit-svc' 'NO DESPLEGADO: bulk-svc' 'RECUPERACIÓN PARCIAL/DESCONOCIDA'; do
  grep -Fq "$status" "$TEMP/partial.log" || { cat "$TEMP/partial.log"; echo "FAIL: falta estado $status" >&2; exit 1; }
done
echo 'PASS: selección completa distingue no desplegado, con recibo, sin recibo, recuperado y desconocido'

cat > "$TEMP/jobs-skipped.json" <<'JOBS'
{"jobs":[
 {"name":"Desplegar catalog-svc en Azure","conclusion":"skipped","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"skipped"}]},
 {"name":"Desplegar taxonomy-svc en Azure","conclusion":"success","steps":[{"name":"Actualizar solo la imagen y verificar revisión/rollback","conclusion":"success"}]}
]}
JOBS
DEPLOY_SCRIPT="$TEMP/deploy-stub.sh" MOCK_DEPLOY_CALLS="$TEMP/deploy-calls.log" GITHUB_STEP_SUMMARY="$TEMP/complete.md" bash "$ROOT/ops/azure/container-apps/reconcile-recovery.sh" \
  '["catalog-svc","taxonomy-svc"]' "$TEMP/artifacts" "$TEMP/jobs-skipped.json" brazil-isolated azure-h5 > "$TEMP/complete.log" 2>&1 || { cat "$TEMP/complete.log"; exit 1; }
grep -Fq 'RECUPERACIÓN COMPLETA:' "$TEMP/complete.log"
echo 'PASS: solo recuperación verificada más servicios omitidos con evidencia permite completar'

grep -Fq -- '--restore taxonomy-svc' "$TEMP/deploy-calls.log" || { cat "$TEMP/deploy-calls.log"; echo 'FAIL: recibo válido no ejecutó restore usando Bash' >&2; exit 1; }
grep -Fq -- '--inspect inventory-svc' "$TEMP/deploy-calls.log" || { cat "$TEMP/deploy-calls.log"; echo 'FAIL: caso sin recibo no ejecutó inspect usando Bash' >&2; exit 1; }
if grep -Fq -- '--restore combos-svc' "$TEMP/deploy-calls.log"; then echo 'FAIL: receipt con destino incompatible llegó al ejecutor de restore' >&2; exit 1; fi
echo 'PASS: recuperación e inspección se ejecutan con Bash sobre un archivo 100644; procedencia incompatible no ejecuta rollback'
