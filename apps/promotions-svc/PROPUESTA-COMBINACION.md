# Propuesta de combinación de beneficios — versión 1

Owner: Axel Cueva · rama `cueva` · issue #72 · 22/10/2026.

**Estado: propuesta definida y prototipo de referencia aislado.** El usuario pidió
resolver la decisión pendiente al no existir acuerdo. Este documento concreta la
regla propuesta por Promotions; no acredita aceptación de Marco ni de otros módulos.
No crea una DEC-F ni modifica OpenAPI, AsyncAPI, datos persistentes o runtime.

## Base normativa y decisiones nuevas

Fuentes G6 consultadas en el commit
`51a5ce6e76bb0c61d93ef47416e46797bf5b9846`:

- [HU-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/requisitos/hu/HU-006-gestion-ofertas-promociones.md),
  CA-06/07/10/11/14/15: monto fijo una vez, mejor alternativa permitida, alcance
  deduplicado, precios de Pricing y consultas sin consumo.
- [SPEC-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/requisitos/specs/SPEC-006-gestion-ofertas-promociones.md):
  identidad SKU/producto, canal, instante y separación entre evaluación y consumo.
- [Registro DEC-F](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/arquitectura/decisiones/REGISTRO_DEC_F.md):
  DEC-F-007 mantiene autoridad de beneficios en Promotions; DEC-F-008 conserva
  consumo atómico separado; DEC-F-012 exige versionar y verificar compatibilidad.
- [OpenAPI 0.6.0-rc.1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/contratos/http/openapi.yaml):
  `EvaluacionPromocionesResponse` contiene un solo `promotion_id`; no tiene lista
  contractual de beneficios aplicados ni asignación monetaria por línea.

La fórmula sucesiva, el reparto proporcional, el significado de la campaña
principal, el desempate de conjuntos y el redondeo de las secciones siguientes
son **decisiones propuestas aquí**, no citas de reglas ya aprobadas.

## Regla elegida

1. Resolver primero la cesta con precios y elegibilidad autoritativos para el mismo
   canal, instante y moneda. Subtotal de línea = precio unitario × cantidad. Las
   líneas duplicadas del mismo SKU deben consolidarse antes del cálculo; una
   discrepancia de identidad, moneda o precio no se resuelve seleccionando un dato.
2. Incluir únicamente campañas activas, vigentes y con alcance aplicable. Un cupón
   debe superar las validaciones propias; se admite como máximo el único código
   presentado. Coincidir por producto y por SKU no duplica el descuento.
3. Construir todos los subconjuntos compatibles, incluidos los individuales. La
   autorización es bilateral para **cada pareja**: automática–automática requiere
   `automaticPromotion` en ambas; automática–cupón requiere `coupon` en la
   automática y `automaticPromotion` en la campaña del cupón. Un permiso ausente
   equivale a no permitir. No se suman dos cupones. Tener alcances distintos no
   evita esta comprobación.
4. Evaluar cada subconjunto sobre precios regulares. Además evaluarlo sobre las
   ofertas de Pricing cuando **todos** sus miembros permiten `pricingOffer`.
   Mantener también la alternativa de solo Pricing. El modo de precios se decide
   para la cesta completa; no se mezclan bases por campaña ni se modifica Pricing.
5. Dentro de un subconjunto, ordenar campañas por prioridad ascendente y luego por
   identificador estable, comparado literalmente. Ese orden es parte de la regla:
   no buscar permutaciones para maximizar el descuento.
6. Aplicar cada descuento al saldo restante de sus líneas elegibles. Para el
   porcentaje `p`: descuento de línea = saldo × p / 100. Para monto fijo `f`:
   `D = min(f, suma de saldos elegibles)` y `D_i = D × saldo_i / suma de saldos`.
   Restar `D_i` solo a la línea correspondiente. Si el subtotal es cero, omitir
   ese beneficio. El monto fijo se aplica una vez, incluso con varios SKU o unidades.
7. Comparar importes finales exactos de todos los subconjuntos permitidos; gana el
   menor. Empate: sin cupón que aporte descuento; luego comparar las listas de
   campañas que aportaron descuento, ordenadas por `(prioridad, id)`, de forma
   lexicográfica; si una lista es prefijo, preferir la más corta. Una alternativa
   sin campañas tiene prioridad conceptual infinita, como en el evaluador actual.
   Si persiste igualdad, conservar la primera alternativa idéntica; no cambia el
   importe ni las identidades aplicadas.
8. Conservar por separado descuento de Pricing, asignaciones de cada campaña y
   saldos finales. Debe cumplirse exactamente: original = descuento + resultado;
   cada asignación suma el descuento de su campaña; ningún saldo es negativo.
   Una campaña/cupón que no aporta ahorro no se atribuye como aplicada.

## Identidad y frontera contractual

Se propone que `EvaluacionPromocionesResponse.promotion_id` identifique la primera
campaña **efectivamente aplicada** según `(prioridad, id)`, o `null` si solo hay
oferta de Pricing o ningún beneficio. **No identifica todo el conjunto ni el cupón.**
No fabricar un UUID concatenado, una campaña sintética o un identificador de pedido.

Para `ValidarCuponResponse.benefit.promotion_id`, conservar la identidad de la
campaña del cupón real; no sustituirla por la campaña principal. La validación
individual no consume ni reserva, y no garantiza el ahorro marginal en una futura
combinación. El consumo posterior sigue validando el cupón real y sus límites.

El prototipo devuelve internamente `applied`, `primaryPromotionId` y
`couponPromotionId`; **no son campos nuevos del HTTP ni un snapshot durable**.
Antes de conectar la propuesta, G6 y los consumidores deben confirmar si el
campo singular con esta semántica basta. Si necesitan reconstruir la composición
en Ventas/Postventa, debe existir un contrato versionado de desglose/snapshot y su
homologación; no se puede reconstruir toda la combinación desde la campaña principal.

## Precisión y propuesta monetaria

El cálculo usa fracciones exactas, incluidas asignaciones como `1/3`. No se elige
una precisión decimal arbitraria durante el reparto ni se redondea cada paso.
Así se evita que el orden de las líneas cree o destruya descuento.

Para la futura salida monetaria se propone:

- PEN: dos decimales; otras monedas necesitan escala explícita acordada.
- Redondear el resultado total una sola vez, al más cercano y mitad hacia arriba.
- Repartir las unidades mínimas de los saldos finales por mayor resto fraccionario,
  con desempate por clave canónica de línea, hasta alcanzar ese total redondeado.
- No redondear de forma independiente original, descuento y resultado: derivar el
  descuento publicado del original monetario menos el resultado publicado, y
  verificar no negatividad y conservación.
- Antes de salida, exigir precios regulares/oferta representables en la escala de
  la moneda. Si no lo son, la integración debe resolver esa discrepancia con Pricing.

**Este redondeo es una propuesta pendiente de homologación y no está implementado
en el prototipo.** No se convierten fracciones a `number` ni se conectan al DTO.
Elegir una regla aquí no acredita que Pricing/Ventas la hayan aceptado.

## Ejemplos de aceptación

Todos usan políticas compatibles, importes antes del redondeo y ausencia de oferta
de Pricing salvo que se indique. La prioridad fija el orden mostrado.

| Caso | Cálculo | Resultado |
| --- | --- | --- |
| 10 % y después 20 % sobre 100 | 100 × 0,9 × 0,8 | 72; no sumar porcentajes. |
| A=60, B=40; fijo 30 en ambos; después 50 % solo en A | Reparto 18/12; saldos 42/28; A queda 21 | 49. |
| A=1, B=2; fijo 1 en ambos; después 50 % en A | Reparto 1/3 y 2/3; saldos finales 1/3 y 4/3 | 5/3 exacto; propuesta PEN 1,67. |
| Regular 100, oferta 80 y automática 15 % exclusiva | Comparar 80 con 85 | 80, campaña principal null. |
| Caso anterior con permiso para Pricing | 80 × 0,85 | 68. |
| Exclusiva 50 % frente a combinación autorizada de 30 % y 40 % | Comparar 50 con 100 × 0,7 × 0,6 | 42. |
| Fijo 50 sobre subtotal 30 | min(50,30) | 0; no consume un cupón adicional sin ahorro. |
| Automática 10 % prioridad 1 y cupón 10 % prioridad 2 | 100 → 90 → 81 | Principal: automática; cupón identificado aparte. |

## Implementación, pruebas y activación

El prototipo está en `test/proposals/combination-policy.ts`, con pruebas en
`test/proposals/combination-policy.spec.ts`. Está fuera de `src/`, del build de
Promotions y de las importaciones HTTP. Usa entradas sintéticas explícitas y
ya elegibles; no sustituye Catálogo, Pricing, JWT, base de datos o broker.

La enumeración de subconjuntos es exponencial y solo sirve como referencia de
corrección para cestas pequeñas. Para producción hace falta un evaluador exacto
con presupuesto de trabajo, límites acordados y error técnico contractual cuando
no pueda completar la búsqueda. No truncar campañas, usar un resultado parcial
ni declarar óptimo un algoritmo voraz. Su optimización y límites no se presentan
como resueltos por este prototipo.

```powershell
npm test -- apps/promotions-svc/test/proposals/combination-policy.spec.ts --maxWorkers=1
```

| Dimensión | Estado |
| --- | --- |
| Regla propuesta | Definida en versión 1; no cambia DEC-F adoptadas. |
| Referencia interna | Implementada en pruebas: fórmula, compatibilidad, identidades y conservación exacta. |
| Pruebas | Ejecución y resultado por separado en el reporte de la entrega. |
| Redondeo/snapshot/límites de producción | Especificados como propuestas o trabajo previo; no implementados. |
| HTTP en producción | Sin cambios; mantiene el gate de combinación múltiple y el provider comercial bloqueado. |
| Homologación externa / despliegue | No realizados. |

## Responsables y desbloqueo verificable

| Owner | Operación | Evidencia necesaria |
| --- | --- | --- |
| Axel/Promotions + Marco/arquitectura G6 | Adoptar composición interna | Revisión registrada de esta versión: orden, reparto, desempate y límites de producción. |
| G6 + owners de Marketplace, Chatbot, Retail y Ventas/Postventa | Respuesta/snapshot de múltiples beneficios | Aceptación verificable de `promotion_id` principal; si hace falta desglose, contrato versionado y pruebas de consumidor. No se presume aceptación por silencio. |
| Pricing + Ventas/Postventa + G6 | Salida monetaria y conciliación | Confirmar escala/redondeo/reparto y ejemplos monetarios; implementar y probar la regla homologada. |
| Catálogo/Pricing + integración G6/G7 | Evaluación comercial real | Adaptadores con identidad autorizada y precios/elegibilidad coherentes para canal/instante. |

Este documento queda listo para revisión; no se enviaron mensajes ni se atribuyó
aprobación a otros owners. #72 permanece parcial y las demás fronteras de #73 no
se desbloquean por definir la fórmula de composición.
