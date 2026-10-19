# Esquemas físicos PostgreSQL observados y modelo de aplicación

## Estado y límites de evidencia

La auditoría histórica de preparación del 2026-10-17 (`hito3-preparacion.md`, sección runtime) registró ocho esquemas y roles de servicio existentes y autenticables desde el host Oracle, con TLS `verify-full`; anotó conteos físicos: catalog 14, taxonomy 13, pricing 8, price_audit 5, promotions 14, inventory 16, combos 6 y bulk 8 tablas. Es evidencia fechada de host-level connectivity, no una comprobación actual desde contenedores ni una garantía de acceso para cada servicio. No se vuelven a publicar usuarios, rutas privadas ni credenciales.

Las listas siguientes son los nombres definidos por las migraciones de `docs/origin/master` SHA `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`, no un inventario de presencia individual realizado en la VM. Cada conteo histórico coincide con las tablas de aplicación listadas más `schema_migrations`. La existencia física del esquema/tablas no demuestra repositorios funcionales, migraciones aplicadas en la revisión actual, permisos correctos, conectividad desde el contenedor ni readiness.

| Schema | Tablas de aplicación según migraciones oficiales |
|---|---|
| `catalog` | `products`, `variants`, `sku_identity`, `product_images`, `variant_images`, `product_attribute_values`, `variant_attribute_values`, `product_identifying_characteristics`, `sku_physical_profiles`, `activation_checks`, `master_barriers`, `outbox`, `inbox` |
| `taxonomy` | `runtime_settings`, `categories`, `brands`, `characteristics`, `characteristic_values`, `product_types`, `product_type_characteristics`, `category_seo`, `slug_history`, `master_deactivation_operations`, `outbox`, `inbox` |
| `pricing` | `prices`, `price_validities`, `scheduled_prices`, `bulk_price_jobs`, `bulk_price_rows`, `outbox`, `inbox` |
| `price_audit` | `inbox`, `price_audit_log`, `export_jobs`, `archive_manifests` |
| `promotions` | `promotions`, `promotion_scopes`, `combination_policy`, `coupons`, `coupon_uses`, `recommendation_rules`, `recommendation_items`, `catalog_projection`, `price_projection`, `stock_projection`, `outbox`, `inbox`, `coupon_command_receipts` |
| `inventory` | `locations`, `stock_balance`, `reservations`, `reservation_lines`, `inventory_operations`, `kardex`, `incidencias`, `traslados`, `traslado_recepciones`, `stock_threshold_override`, `inventory_config`, `dashboard_projection`, `outbox`, `inbox`, `commercial_fulfillment_routes` |
| `combos` | `combos`, `combo_items`, `component_projection`, `outbox`, `inbox` |
| `bulk` | `file_manifests`, `batch_jobs`, `batch_rows`, `row_domain_steps`, `export_jobs`, `outbox`, `inbox` |

## Implementación por separado

- Repositorios y readiness reales están identificados en Catalog (rama Poma), Taxonomy (rama Lopez) y Pricing (rama Vera). Su existencia se comprueba en esos SHAs, no en el mero inventario físico.
- Inventory (rama Taco) y Promotions (rama Cueva) tienen implementaciones candidatas de persistencia; no están integradas y requieren pruebas aisladas y configuración exacta de sus fichas.
- Price Audit, Combos y Bulk mantienen scaffolds o implementación incompleta respecto a persistencia/negocio en los HEAD registrados en sus fichas.
- Gateway no tiene esquema propio. Su `read_model` documentado queda fuera de estos ocho esquemas operativos de servicios.

No conceder, ampliar ni inferir permisos. Cualquier cambio SQL en Supabase necesita autorización expresa, alcance y proceso de despliegue aprobado; esta ficha no ejecuta ni propone DDL.
