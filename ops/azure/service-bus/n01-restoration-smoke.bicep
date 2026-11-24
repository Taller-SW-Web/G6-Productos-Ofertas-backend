targetScope = 'resourceGroup'

@description('Región aprobada para el grupo de contenedores temporal.')
param location string = 'brazilsouth'

@description('Nombre único para el ACI descartable de N01.')
param containerGroupName string = 'h5-n01-${substring(uniqueString(resourceGroup().id, deployment().name), 0, 12)}'

@description('SHA oficial de master que el runner descargará y compilará.')
@minLength(40)
@maxLength(40)
param sourceSha string

@description('ID de la UAMI Promotions ya existente y autorizada sobre la cola.')
param promotionsIdentityResourceId string

@description('Client ID de la UAMI Promotions; no es un secreto.')
param promotionsClientId string

@description('Credencial efímera para el PostgreSQL privado del mismo grupo ACI.')
@secure()
param postgresPassword string

@description('URL PostgreSQL local; secure parameter generado solo para esta ejecución.')
@secure()
param postgresUrl string

@description('Nombre aleatorio de la base temporal.')
param databaseName string

var statusMount = [{ name: 'status', mountPath: '/n01-status' }]
var runnerImage = 'node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d'
var postgresImage = 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'

resource n01Smoke 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: containerGroupName
  location: location
  tags: {
    purpose: 'g6-h5-n01-restoration-smoke'
    sourceSha: sourceSha
    production: 'false'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${promotionsIdentityResourceId}': {}
    }
  }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Never'
    volumes: [{ name: 'status', emptyDir: {} }]
    // No ipAddress and no ports: the group has no public endpoint. The two
    // containers share localhost, which is required by the original smoke.
    containers: [
      {
        name: 'runner'
        properties: {
          image: runnerImage
          command: [
            '/bin/sh'
            '-c'
            '''
set -eu
trap "touch /n01-status/done" EXIT
apt-get update -qq
apt-get install -y -qq --no-install-recommends git ca-certificates
git clone --quiet --filter=blob:none --no-checkout https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend.git /tmp/backend
git -C /tmp/backend checkout --quiet --detach "$G6_H5_SOURCE_SHA"
test "$(git -C /tmp/backend rev-parse HEAD)" = "$G6_H5_SOURCE_SHA"
cd /tmp/backend
npm ci
npm run build:promotions-svc
node -e "let n=0;const p=()=>{const s=require(\"node:net\").connect(5432,\"127.0.0.1\");s.on(\"connect\",()=>process.exit(0));s.on(\"error\",()=>{if(++n>60)process.exit(1);setTimeout(p,1000)})};p()"
if ! node apps/promotions-svc/h5/smoke-azure-restauracion.mjs > /tmp/n01-smoke.log 2>&1; then cat /tmp/n01-smoke.log; exit 1; fi
cat /tmp/n01-smoke.log
node --input-type=module -e 'import {Pool} from "pg"; import {readFileSync} from "node:fs"; const events=[]; for(const line of readFileSync("/tmp/n01-smoke.log","utf8").split(/\r?\n/)){try{events.push(JSON.parse(line))}catch{}} const result=events.find((e)=>e.step==="result"&&e.status==="PASS"); if(!result)throw Error("SMOKE_RESULT_MISSING"); const pool=new Pool({connectionString:process.env.G6_H5_SQL_URL}); try { const [outbox,inbox,receipt,effects]=await Promise.all([pool.query("SELECT attempts,sent_at FROM promotions.h5_coupon_outbox WHERE message_id=$1",[result.message_id]),pool.query("SELECT count(*)::int AS rows FROM promotions.inbox WHERE message_id=$1 AND completed_at IS NOT NULL",[result.message_id]),pool.query("SELECT count(*)::int AS rows FROM promotions.coupon_command_receipts WHERE operation_id=$1",[result.operation_id]),pool.query("SELECT count(*)::int AS rows FROM promotions.coupon_uses WHERE order_id=$1",["G6-H5-AZURE-NO-PRIOR-USE-"+result.operation_id])]); console.log(JSON.stringify({step:"sql-verification",sha:result.sha,message_id:result.message_id,correlation_id:result.correlation_id,operation_id:result.operation_id,outbox_attempts:outbox.rows[0]?.attempts??null,outbox_sent:Boolean(outbox.rows[0]?.sent_at),inbox_rows:inbox.rows[0].rows,receipt_rows:receipt.rows[0].rows,coupon_effects:effects.rows[0].rows})); } finally { await pool.end(); }'
'''
          ]
          resources: {
            requests: {
              cpu: 1
              memoryInGB: 2
            }
          }
          volumeMounts: statusMount
          environmentVariables: [
            { name: 'G6_H5_AZURE_SMOKE', value: 'isolated-restoration' }
            { name: 'G6_H5_SOURCE_SHA', value: sourceSha }
            { name: 'G6_H5_AZURE_CLIENT_ID', value: promotionsClientId }
            {
              name: 'G6_H5_SQL_URL'
              secureValue: postgresUrl
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          image: postgresImage
          command: [
            '/bin/sh'
            '-c'
            '''
while [ ! -f /n01-status/done ]; do
  /usr/local/bin/docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 &
  server=$!
  while kill -0 "$server" 2>/dev/null; do
    if [ -f /n01-status/done ]; then kill -TERM "$server"; break; fi
    sleep 2
  done
  wait "$server"
  [ -f /n01-status/done ] && exit 0
done
'''
          ]
          resources: {
            requests: {
              cpu: json('0.5')
              memoryInGB: json('0.5')
            }
          }
          volumeMounts: statusMount
          environmentVariables: [
            { name: 'POSTGRES_DB', value: databaseName }
            { name: 'POSTGRES_USER', value: 'postgres' }
            { name: 'POSTGRES_PASSWORD', secureValue: postgresPassword }
          ]
        }
      }
    ]
  }
}

output containerGroupId string = n01Smoke.id
output sourceSha string = sourceSha
