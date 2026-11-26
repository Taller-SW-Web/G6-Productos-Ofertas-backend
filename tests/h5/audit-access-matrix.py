"""Read-only reconciliation; external grants and deployments are never inferred."""
import csv
import json
import subprocess
import sys
from pathlib import Path

import yaml

root = Path.cwd()
docs = root.parent / 'docs'
source = Path(sys.argv[1])
with source.open(encoding='utf-8-sig', newline='') as stream:
    supplied = list(csv.DictReader(stream))
runtime = json.loads(subprocess.check_output([
    'node', '-e', "console.log(JSON.stringify([...require('./dist/apps/api-gateway/routing/contract-routes.js').CONTRACT_ROUTES,...require('./dist/apps/api-gateway/routing/g5-h5-routes.js').G5_H5_ROUTES]))"
], text=True))
contract = yaml.safe_load((docs / 'contratos/http/openapi.yaml').read_text(encoding='utf-8'))
operations = {}
for path, item in contract['paths'].items():
    for method, operation in item.items():
        if method not in ('get', 'post', 'patch', 'put', 'delete', 'head', 'options'):
            continue
        operations[operation['operationId']] = dict(operation, method=method.upper(), path=path)

parity = []
for route in runtime:
    operation = operations.get(route['operationId'])
    differences = []
    if operation is None:
        differences.append('operation_missing')
    else:
        expected = {
            'method': operation['method'],
            'scope': operation.get('x-required-scope'),
            'audience': operation.get('x-service-audience'),
            'clients': sorted(operation.get('x-allowed-client-ids') or []),
            'security': sorted({key for entry in operation.get('security', []) for key in entry}),
        }
        actual = {key: route.get(key) for key in expected}
        actual['clients'] = sorted(actual['clients'] or [])
        actual['security'] = sorted(actual['security'] or [])
        differences = [key for key in expected if actual[key] != expected[key]]
    parity.append({'operationId': route['operationId'], 'differences': differences})

rows = []
for number, row in enumerate(supplied, 1):
    record = {'sourceRow': number, **row, 'grant_verified_now': False}
    if row['api_duena'] != 'G6':
        record['reconciliation'] = 'EXTERNAL_CONTRACT_CONTROLLED_NOT_AUTHORITATIVE'
    elif row['tipo_jwt'] == 'userBearer' or row['estado_acceso'] == 'OPERACIONES_USER_BEARER':
        record['reconciliation'] = 'ADMINISTRATIVE_USER_OPERATIONS'
    else:
        route = next((entry for entry in runtime if entry['method'] == row['metodo'] and entry['path'] == row['endpoint']), None)
        if route:
            failures = []
            if row['tipo_jwt'] not in route['security']:
                failures.append('security')
            if row['audiencia_requerida'] != route.get('audience'):
                failures.append('audience')
            if row['scope_requerido'] != route.get('scope'):
                failures.append('scope')
            if route.get('clients') and row['client_id'] not in route['clients']:
                failures.append('client')
            record.update(runtime_scope=route.get('scope'), runtime_clients=route.get('clients'),
                          reconciliation='RUNTIME_MATCH' if not failures else 'RUNTIME_DIFFERENCE', differences=failures)
        else:
            operation = next((entry for entry in operations.values() if entry['method'] == row['metodo'] and entry['path'] == row['endpoint']), None)
            record['reconciliation'] = 'PRIVATE_ABSENT_FROM_GATEWAY' if operation and operation.get('x-internal') else 'NO_GATEWAY_ROUTE'
            if operation:
                record.update(contract_scope=operation.get('x-required-scope'), contract_clients=operation.get('x-allowed-client-ids'))
    rows.append(record)

result = {'source': source.name, 'actualRows': len(rows), 'claimedRowsInMD': 84,
          'openApiVersion': contract['info']['version'], 'gatewayRoutesIncludingEnabledG5': len(runtime),
          'contractOperations': len(operations), 'parity': parity, 'rows': rows,
          'note': 'Static code/contract parity; not G7 grant, external homologation, frontend E2E or Azure deployment evidence.'}
output = docs / 'hitos/h5/evidencias/r2-cierre-iteracion-7/PARIDAD_ACCESOS_80.json'
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'actualRows': len(rows), 'parityDifferences': [entry for entry in parity if entry['differences']],
                  'accessDifferences': [entry for entry in rows if entry['reconciliation'] in ('RUNTIME_DIFFERENCE', 'NO_GATEWAY_ROUTE')]}))
