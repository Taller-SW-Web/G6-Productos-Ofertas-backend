#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REGISTRY="$ROOT/ops/shared/services-ci.psv"
EXPECTED='api-gateway|3000|API_GATEWAY_PORT
bulk-svc|3008|BULK_SVC_PORT
catalog-svc|3001|CATALOG_SVC_PORT
combos-svc|3007|COMBOS_SVC_PORT
inventory-svc|3005|INVENTORY_SVC_PORT
price-audit-svc|3003|PRICE_AUDIT_SVC_PORT
pricing-svc|3002|PRICING_SVC_PORT
promotions-svc|3004|PROMOTIONS_SVC_PORT
taxonomy-svc|3006|TAXONOMY_SVC_PORT'

actual="$(awk -F'|' '$1 !~ /^#/ && NF { print }' "$REGISTRY")"
[[ "$actual" == "$EXPECTED" ]] || { echo 'FAIL: registro neutral distinto del inventario aprobado de nueve servicios' >&2; exit 1; }
[[ "$(awk -F'|' '$1 !~ /^#/ && NF { seen[$2]++ } END { for (port in seen) if (seen[port] != 1) exit 1; print NR-1 }' "$REGISTRY")" == 9 ]] || {
  echo 'FAIL: puertos duplicados o servicio ausente en el inventario neutral' >&2
  exit 1
}
grep -Fq "npm run \"build:\$service_name\"" "$ROOT/ops/shared/build-service.sh"
grep -Fq "import './%s/main.js'" "$ROOT/ops/shared/build-service.sh"
grep -Fq 'dist/apps/g6-service-entrypoint.mjs' "$ROOT/ops/shared/build-service.sh"
grep -Fq 'COPY ops/shared ./ops/shared' "$ROOT/Dockerfile.service"
grep -Fq "bash ops/shared/build-service.sh \"\$SERVICE_NAME\"" "$ROOT/Dockerfile.service"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/ops/shared" "$TEMP/dist/apps" "$TEMP/bin"
cp "$ROOT/ops/shared/build-service.sh" "$TEMP/ops/shared/build-service.sh"
cp "$REGISTRY" "$TEMP/ops/shared/services-ci.psv"
cat > "$TEMP/bin/npm" <<'MOCK_NPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BUILD_LOG"
MOCK_NPM
chmod +x "$TEMP/bin/npm"
while IFS='|' read -r service record; do
  [[ -n "$service" && "$service" != \#* ]] || continue
  [[ "$record" == *'|'* ]] || { echo "FAIL: malformed service row: $service" >&2; exit 1; }
  : > "$TEMP/build.log"
  (cd "$TEMP" && env PATH="$TEMP/bin:$PATH" BUILD_LOG="$TEMP/build.log" bash "$TEMP/ops/shared/build-service.sh" "$service")
  [[ "$(cat "$TEMP/build.log")" == "run build:$service" ]]
  [[ "$(cat "$TEMP/dist/apps/g6-service-entrypoint.mjs")" == "import './$service/main.js';" ]]
done < "$REGISTRY"
if (cd "$TEMP" && env PATH="$TEMP/bin:$PATH" BUILD_LOG="$TEMP/build.log" bash "$TEMP/ops/shared/build-service.sh" unknown-svc) >/dev/null 2>&1; then
  echo 'FAIL: builder accepted a service outside the registry' >&2
  exit 1
fi
echo 'PASS: inventario neutral conserva los nueve servicios, puertos, variables y entrada Nest compilada'
