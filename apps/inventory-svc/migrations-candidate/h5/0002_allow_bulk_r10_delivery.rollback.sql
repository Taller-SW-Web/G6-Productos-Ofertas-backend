-- Rollback candidato R10. Abortará si existe cualquier entrega Bulk.
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
    RAISE EXCEPTION 'Rollback R10 requiere po_inventory_owner';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO existing_definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'inventory' AND t.relname = 'outbox_delivery'
    AND c.conname = 'ck_inventory_delivery_route' AND c.contype = 'c';
  IF existing_definition IS NULL OR existing_definition NOT LIKE '%g6.bulk.from.inventory%'
     OR existing_definition NOT LIKE '%g6.catalog.from.inventory%'
     OR existing_definition NOT LIKE '%g6.combos.from.inventory%'
     OR existing_definition NOT LIKE '%g6.promotions.from.inventory%'
     OR existing_definition NOT LIKE '%route_version = 1%'
     OR existing_definition NOT LIKE '%AZURE_SERVICE_BUS%'
     OR regexp_count(existing_definition, 'g6[.]') <> 4 THEN
    RAISE EXCEPTION 'Rollback R10: definición R10 ausente o inesperada';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory.outbox_delivery WHERE destination = 'g6.bulk.from.inventory') THEN
    RAISE EXCEPTION 'Rollback R10: existen entregas Bulk; reconciliar antes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'inventory' AND t.relname = 'outbox_delivery'
      AND c.conname = 'ck_inventory_delivery_route_previous'
  ) THEN
    RAISE EXCEPTION 'Rollback R10: constraint temporal preexistente';
  END IF;

  ALTER TABLE inventory.outbox_delivery
    ADD CONSTRAINT ck_inventory_delivery_route_previous CHECK (
      route_version = 1 AND transport = 'AZURE_SERVICE_BUS' AND
      destination IN (
        'g6.catalog.from.inventory', 'g6.combos.from.inventory',
        'g6.promotions.from.inventory'
      )
    ) NOT VALID;
  ALTER TABLE inventory.outbox_delivery
    VALIDATE CONSTRAINT ck_inventory_delivery_route_previous;
  ALTER TABLE inventory.outbox_delivery
    DROP CONSTRAINT ck_inventory_delivery_route;
  ALTER TABLE inventory.outbox_delivery
    RENAME CONSTRAINT ck_inventory_delivery_route_previous TO ck_inventory_delivery_route;
END;
$guard$;

COMMIT;
