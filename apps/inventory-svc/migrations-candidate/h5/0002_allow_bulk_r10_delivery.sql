-- Candidato R10. NO APLICADO a Supabase compartido.
-- Ejecutar solo como po_inventory_owner, después del preflight y aprobación de despliegue.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  existing_definition text;
BEGIN
  IF current_user <> 'po_inventory_owner'
     OR NOT EXISTS (
       SELECT 1 FROM pg_namespace
       WHERE nspname = 'inventory' AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     ) THEN
    RAISE EXCEPTION 'R10 requiere po_inventory_owner y ownership del schema inventory';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO existing_definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'inventory' AND t.relname = 'outbox_delivery'
    AND c.conname = 'ck_inventory_delivery_route' AND c.contype = 'c';

  IF existing_definition IS NULL
     OR existing_definition NOT LIKE '%route_version = 1%'
     OR existing_definition NOT LIKE '%AZURE_SERVICE_BUS%'
     OR existing_definition NOT LIKE '%g6.catalog.from.inventory%'
     OR existing_definition NOT LIKE '%g6.combos.from.inventory%'
     OR existing_definition NOT LIKE '%g6.promotions.from.inventory%' THEN
    RAISE EXCEPTION 'R10 preflight: constraint de rutas ausente o inesperada';
  END IF;
  IF existing_definition LIKE '%g6.bulk.from.inventory%' THEN
    IF regexp_count(existing_definition, 'g6[.]') <> 4 THEN
      RAISE EXCEPTION 'R10 preflight: destinos adicionales inesperados';
    END IF;
    RETURN; -- idempotente si la definición esperada ya está presente
  END IF;
  IF regexp_count(existing_definition, 'g6[.]') <> 3 THEN
    RAISE EXCEPTION 'R10 preflight: destinos adicionales inesperados';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'inventory' AND t.relname = 'outbox_delivery'
      AND c.conname = 'ck_inventory_delivery_route_r10'
  ) THEN
    RAISE EXCEPTION 'R10 preflight: constraint temporal preexistente';
  END IF;

  ALTER TABLE inventory.outbox_delivery
    ADD CONSTRAINT ck_inventory_delivery_route_r10 CHECK (
      route_version = 1 AND transport = 'AZURE_SERVICE_BUS' AND
      destination IN (
        'g6.catalog.from.inventory', 'g6.combos.from.inventory',
        'g6.promotions.from.inventory', 'g6.bulk.from.inventory'
      )
    ) NOT VALID;
  ALTER TABLE inventory.outbox_delivery
    VALIDATE CONSTRAINT ck_inventory_delivery_route_r10;
  ALTER TABLE inventory.outbox_delivery
    DROP CONSTRAINT ck_inventory_delivery_route;
  ALTER TABLE inventory.outbox_delivery
    RENAME CONSTRAINT ck_inventory_delivery_route_r10 TO ck_inventory_delivery_route;
END;
$guard$;

COMMIT;
