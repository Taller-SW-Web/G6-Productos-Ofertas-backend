# DATA-005: preparación de maestros de Inka Athletics

Issue #15. Owner: Axel Cueva. Rama `cueva`. Fecha: 2026-10-16, America/Lima.
Estado: `IMPLEMENTAR_PARCIAL`. Modo real: lectura MCP y diseño; sin ensayo ni
persistencia. No se modificaron schemas, grants, migraciones ni datos.

## Fuentes y baseline

Docs `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`: modelo físico de Promotions,
SPEC-005/006/007, DEC-F-007/008/009/012 y guía PostgreSQL de desarrollo local.
`baseline-2026-10-16.json` conserva columnas, constraints, triggers y permisos
declarados consultados, y los conteos nuevos de las seis tablas maestras propias
y tres proyecciones propias: **todos cero**. No se consultaron schemas ajenos.

La consulta se ejecutó con el MCP como `postgres`, no con el login individual.
Los permisos SELECT/INSERT/UPDATE/DELETE declarados de `promotions_dev_login`
se comprobaron como metadatos para las seis tablas maestras; eso no demuestra
una conexión autenticada con ese login. El `.env.local` del usuario se carga,
pero al validarlo falta `RABBITMQ_URL` y la ruta de `PGSSLROOTCERT` no existe.
No se imprimieron valores. No se ejecutó una conexión local sin CA validado.

## Borrador comercial

`inka-athletics-draft.json` contiene IDs propios estables, orden propuesto y
filas propuestas separadas del diseño pendiente de recomendaciones:

- Semana Running: 10 % sintético sobre referencias running por vincular,
  automática, inactiva, una semana, sin combinación con otros beneficios.
- Entrena en Equipo: 5 % sintético mediante cupón demo inactivo, dos semanas,
  20 usos globales y uno por cliente, sin usos precargados ni compra simulada.
- Cross-sell de zapatillas running con medias deportivas y de balón de fútbol
  con accesorio de entrenamiento. Se especifica la selección comercial, pero
  **no** se fabrican IDs de origen/candidatos.

Los descuentos son propuestas pendientes de contrastar con los precios de las
referencias finales. Todas las campañas/cupones están INACTIVO. No se promete
beneficio real ni elegibilidad actual.

**El borrador no es ejecutable.** `promotion_scopes`, `recommendation_rules` y
`recommendation_items` siguen sin filas definitivas. Los triggers de completitud
impiden insertar promociones sin alcance y reglas sin candidatos. No se eluden
con referencias ficticias ni sembrando proyecciones.

No se encontraron manifiestos de negocio en el `master` Backend consultado
`24227527c632be4f3b8de612954328904ea57de0`. Las ramas remotas `poma` y `vera`
consultadas apuntaban a `42b5143db14d2722e6f37d8a4ef41f02eded03b5`, sin manifiestos.
Los comentarios de #12/#13 son backlinks de coordinación, no publicaciones de
referencias/precios. Esto describe las fuentes consultadas, no toda actividad
posible de los otros owners.

## Dependencias específicas

| Owner                         | Operación                                    | Desbloqueo verificable                                                                                                                                        |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gabriel Poma / Catálogo / #12 | Alcances de campaña y recomendaciones        | Manifiesto/API versionados con IDs/SKU vendibles de las familias elegidas y sus estados.                                                                      |
| Leonardo Vera / Pricing / #13 | Coherencia económica y elegibilidad          | Precios, canales y vigencias publicados para las referencias elegidas.                                                                                        |
| Axel / configuración local    | Autenticación PostgreSQL con el login propio | El CA ya pasa la validación local; aún falta comprobar la conexión/TLS e identidad. RABBITMQ_URL sigue pendiente para el arranque real.                       |
| Marco / owner Promotions      | Ensayo en compartido                         | Autorizar alcance, tablas y destino del ensayo; revisar cuerpos/efectos de triggers y garantizar transacción completa.                                        |
| Marco / owner Promotions      | Persistencia                                 | Tras completar referencias y validaciones, aprobar SQL/manifiesto/hash y destino exactos; baseline fresco, comparación de conflictos, repetición y postcheck. |

La preparación no espera homologación G1/G4/G5/G7. La frontera de referencias
pendientes no paraliza el diseño interno de Promotions. El registry del runner
alternativo no es un requisito para esta preparación MCP.

## Reproducción y control

```powershell
node scripts/seed/mcp/promotions/validate-draft.mjs
node --test scripts/seed/mcp/promotions/validate-draft.test.mjs
```

El validador comprueba decimales exactos sin redondear porcentajes, períodos,
identidades, unicidad, política de combinación, límites y estado inactivo.
Un PASS acredita coherencia interna del borrador: el resultado conserva
`insertable_batch=NO`, referencias pendientes y cero escrituras compartidas.
No acredita coherencia económica con precios ni referencias publicadas.

`trigger-body-review-2026-10-16.json` añade una revisión posterior de los cuerpos
de seis funciones de triggers de maestros obtenidos con SELECT/MCP. Documenta
alcance, hashes de definición y límites; no altera el baseline anterior ni
autoriza un ensayo. No se observaron efectos externos en esos cuerpos revisados.

`SHA256SUMS` registra los hashes de bytes exactos de los JSON de esta entrega.
Vincular referencias cambia el contenido: generar una nueva versión y hash,
revisar conflictos y obtener las autorizaciones del lote final. No reescribir
evidencia de un lote aplicado ni interpretar PREPARADO como ROLLBACK o COMMIT.

Los metadatos de preparación no son DTOs ni contratos públicos. No se incluyen
SQL ejecutable, arrays en producción, cupón consumido, ventas, inbox/outbox,
receipts, proyecciones, datos de inventario ni schema_migrations.
