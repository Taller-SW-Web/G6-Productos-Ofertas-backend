# Revisión G7 de permisos HTTP H5 G6 y disponibilidad G5

Continuación de la coordinación de Seguridad #107. Referencia de rutas, esquemas y seguridad en [OpenAPI 0.7.0-rc.2](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/937b7deb4bde25a282ebb52bbfd16195ad684195/contratos/http/openapi.yaml).

## Permiso existente que requiere confirmación efectiva

Cliente modulo-ventas, tipo servicio, audiencia api-productos: confirmar/conceder inventario:disponibilidad:leer para GET /api/v1/inventario/disponibilidad. OpenAPI G6 contempla esta consulta para Ventas y Postventa; no se amplían permisos de reserva/consumo a modulo-postventa.

## Grants que debe verificar G7

| Cliente | Operación | Scope con audiencia `api-productos` |
|---|---|---|
| `modulo-ventas` | POST /api/v1/cupones/consumos | `cupones:consumir` |
| `modulo-ventas` | POST /api/v1/cupones/restauraciones | `cupones:restaurar` |
| `modulo-ventas` | GET /api/v1/cupones/operaciones/{operationId} | `cupones:operaciones:leer` |
| `modulo-ventas` | GET /api/v1/inventario/reservas/{reservaId}/estado | `inventario:reservas:estado:leer` |
| `promotions-svc` | GET /api/v1/interno/inventario/reservas/{reservaId}/evidencia-cupon | `inventario:reservas:estado:leer` |

G7 debe registrar y conceder a `promotions-svc` el scope `ventas:pedidos:evidencia-cupon:leer`, audiencia **`api-ventas`**, para la [lectura privada solicitada a G5](CONTRATO_EVIDENCIA_CUPON_G5.md). Según SPEC-17 de G7, la audiencia proviene de la API dueña de los scopes incluidos en el JWT. Se pide confirmar emisión con el secreto del cliente técnico G6 y preservar la identidad separada de `modulo-ventas`. El preflight también exige comprobar los grants existentes de Catálogo y de la secuencia de inventario según OpenAPI.

El lector privado de Inventory exige el sujeto `promotions-svc` aunque Ventas tenga el mismo scope para la ruta externa. Promotions solicita su propio token con una credencial dedicada. Los GET acotan la lectura al pedido y al cliente habilitado. G6 valida firma, emisor, audiencia, expiración, tipo, cliente y scope.

Service Bus es exclusivamente interno G6. Azure RBAC no sustituye scopes G7; no se entregan secretos del bus a otros módulos.

## Cierre verificable solicitado

1. Tabla aprobada cliente/audiencia/operación/scope y confirmación del permiso existente.
2. Responsable y mecanismo privado de provisioning; sin credenciales/JWT en el issue.
3. Una vez homologadas las rutas con G5, emisión real y pruebas positivas/negativas G7→G6 por SHA/ambiente. Definición contractual, concesión efectiva y E2E se registran separadamente.

Las rutas están en el código de Backend PR #250 bajo flags H5 y autenticación G7. La publicación documental, los grants efectivos y el despliegue se verifican por separado. El runtime de consumo requiere el snapshot autorizado de G5.

## Comprobación privada con G7

Ejecutar desde el entorno autorizado con el origen HTTPS privado de Inventory y una reserva sintética conocida del mismo ambiente. Usar la credencial técnica de `promotions-svc` provisionada por G7. Solicitar `POST /api/v1/auth/token` con `grant_type=client_credentials`, `client_id=promotions-svc` y `scope=inventario:reservas:estado:leer`. Mantener client secret y access token en un almacén de secretos o en memoria. Registrar SHA, ambiente, correlation ID, HTTP status y código de error por caso.

En PowerShell 7, el siguiente ejemplo toma únicamente la referencia de reserva, el origen autorizado y los tokens ya emitidos e inyectados en el proceso. Los JWT no se pasan como argumentos ni se incluyen en la salida.

```powershell
$origin = [uri]$env:G6_H5_INVENTORY_PRIVATE_ORIGIN
if ($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment) {
  throw 'Se requiere el origen HTTPS privado de Inventory'
}
$reservation = [guid]$env:G6_H5_TEST_RESERVATION_ID
$order = [uri]::EscapeDataString($env:G6_H5_TEST_ORDER_ID)
$url = [uri]::new($origin, "/api/v1/interno/inventario/reservas/$reservation/evidencia-cupon?order_id=$order")
$cases = @(
  @{ Name = 'sin token'; Expected = 401 },
  @{ Name = 'audiencia incorrecta'; Token = $env:G6_H5_WRONG_AUD_JWT; Expected = 401 },
  @{ Name = 'modulo-ventas'; Token = $env:G6_H5_VENTAS_JWT; Expected = 403 },
  @{ Name = 'scope incorrecto'; Token = $env:G6_H5_WRONG_SCOPE_JWT; Expected = 403 },
  @{ Name = 'promotions-svc'; Token = $env:G6_H5_PROMOTIONS_JWT; Expected = 200 }
)
foreach ($case in $cases) {
  $headers = @{ 'X-Correlation-Id' = [guid]::NewGuid().ToString() }
  if ($case.ContainsKey('Token')) {
    if (-not $case.Token) { throw "Falta el token de prueba para $($case.Name)" }
    $headers.Authorization = "Bearer $($case.Token)"
  }
  $result = Invoke-WebRequest -Uri $url -Headers $headers -MaximumRedirection 0 -SkipHttpErrorCheck
  $body = $result.Content | ConvertFrom-Json
  [pscustomobject]@{
    Case = $case.Name
    Status = [int]$result.StatusCode
    Code = $body.code
    CorrelationId = $headers['X-Correlation-Id']
  }
  if ([int]$result.StatusCode -ne $case.Expected) { throw 'Estado HTTP inesperado' }
  if ($case.Expected -eq 200 -and ($body.reservation_id -ne $reservation.ToString() -or
      $body.order_id -cne $env:G6_H5_TEST_ORDER_ID)) {
    throw 'La evidencia no corresponde a la reserva y el pedido de prueba'
  }
}
```

Para el negativo de Ventas, usar el token legítimo de `modulo-ventas` con el scope de lectura. El negativo de scope requiere un token auténtico de `promotions-svc` con un permiso diferente, y el de audiencia un JWT auténtico destinado a otra audiencia. Si G7 no puede emitir uno de esos tokens en el ambiente de prueba, registrar el caso pendiente y la razón. No modificar JWT ni guardar credenciales en el PR. A la fecha de esta corrección las pruebas con tokens emitidos por G7 siguen pendientes.
