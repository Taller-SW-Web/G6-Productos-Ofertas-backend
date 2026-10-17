# Intervención temporal de Marco — INT-ASAP G1

Actualización de autorización: Marco autorizó expresamente en el chat modificar
package.json y package-lock.json para declarar pg, drizzle-orm y @types/pg.
Versiones exactas: 8.23.1, 0.45.4 y 8.23.1 respectivamente. Esta autorización
no permite actualizar otras dependencias. Posteriormente Marco autorizó commit y push a castilla para auditoría; esa instrucción sustituye el aislamiento inicial de #117 y el límite inicial de publicación, sin autorizar merge ni despliegue.

Autorización: solicitud explícita de Marco en esta sesión, 2026-10-16. Trabajo
local sin commits, push, merge, despliegue ni SQL de escritura. Rama `castilla`,
base `7b15faeb421e7a54bfbf3e8250d6718023dcc3bb`. Los archivos locales previos de
runtime/smoke se conservan. PR #117 permanece intacto en GitHub.

## Comentario preparado para #19 (no publicado)

Marco Castilla asume temporalmente el corte mínimo HTTP G1: configuración y
provider PostgreSQL de taxonomy-svc, repositorios de lectura de catalog-svc y
composición local con el Gateway de #116. Esta autorización excepcional en
`castilla` permite esos dos bounded contexts; no transfiere ownership permanente
de López/Poma. No incluye CRUD, códigos de barras, DATA, migraciones, grants,
contratos, escrituras compartidas ni despliegue. Se preparan cambios locales
revisables; no se crean ramas ni se publica sobre #117. Dependencias compartidas
sujetas a autorización expresa separada. D-CAT-05/06 permanece pendiente: sin
fallback ACTIVO→MARKETPLACE. No se cierran issues ni se atribuye homologación.

## Comentario preparado para #22 (no publicado)

Excepción temporal autorizada por Marco: conectar PostgreSQL/Drizzle al puerto
TAXONOMY_REPOSITORY del PR #18, SHA
`4c1214862d106b66f9892bfc72e14450a6b31406`. Reutilizar solo apps/taxonomy-svc,
sin DATA-001 ni modificar `lopez`. López conserva responsabilidad permanente y
absorberá posteriormente el provider, configuración, lifecycle y pruebas.
Lecturas exclusivamente de categorías/marcas ACTIVO; readiness interna distinta
de /health. Alcance #34/#35/#37 parcial, sin afirmar cierre de esos BACK completos.

## Comentario preparado para #23 (no publicado)

Excepción temporal autorizada por Marco: implementar en el scaffold oficial de
catalog-svc solamente configuración, provider y consultas propias de productos,
variantes, imágenes y atributos. Sin alterar `poma`, sin CRUD ni barras. Poma
conserva responsabilidad permanente y absorberá los cambios revisados. Marca y
validación de filtros maestros por HTTP Taxonomy, nunca SQL cross-schema.
D-CAT-05/06 bloquea específicamente la exposición comercial; filtros de precio
permanecen cerrados hasta disponer de semántica product-level y adaptador Pricing.
Alcance #43/#44/#46 parcial. No se cierran issues ni se considera E2E terminado.

## Incorporaciones locales identificadas

- Taxonomy: solo aplicación del PR #18, sin scripts/seed.
- Gateway: solo aplicación del PR #116, SHA
  `98ad846a0046586cfe17cde5a2f9be8f101d8cb9`, sin Promotions ni archivos globales.
- Catalog: origin/poma no contiene código de aplicación; se reutiliza scaffold
  ya presente en HEAD. No se sobrescribe implementación de Poma.
- Fuentes: OpenAPI 0.6.0-rc.1, SPEC/HU/FLOW 003/004/008/011,
  DEC-F-001/011, arquitectura y modelos físicos oficiales.

Clasificación: Taxonomy IMPLEMENTAR_AHORA; Catalog IMPLEMENTAR_PARCIAL;
exposición comercial por canal BLOQUEADO_ESPECÍFICO (Marco/Poma: aprobar fuente,
persistencia/default y política D-CAT-05/06 verificable). G7 solo bloquea la
integración externa con identidad efectiva; issuer firmado aislado permitido localmente.
