-- Migración aditiva H5. Aplicar solo mediante el proceso autorizado de BD.
-- No crea entregas históricas: el corte requiere clasificación y conciliación aprobadas.
CREATE TABLE IF NOT EXISTS taxonomy.outbox_delivery (
  message_id uuid NOT NULL REFERENCES taxonomy.outbox(message_id),
  destination text NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, destination)
);

CREATE OR REPLACE FUNCTION taxonomy.enqueue_catalog_delivery_h5()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.event_name IN (
    'taxonomy.category.updated', 'taxonomy.product-type-schema.changed',
    'taxonomy.characteristic-value.updated', 'taxonomy.master.deactivation.check.requested',
    'taxonomy.master.deactivated', 'taxonomy.master.deactivation.rejected'
  ) THEN
    INSERT INTO taxonomy.outbox_delivery (message_id, destination)
    VALUES (NEW.message_id, 'g6.catalog.from.taxonomy')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION taxonomy.enqueue_catalog_delivery_h5() FROM PUBLIC;

DROP TRIGGER IF EXISTS taxonomy_enqueue_catalog_delivery_h5 ON taxonomy.outbox;
CREATE TRIGGER taxonomy_enqueue_catalog_delivery_h5
AFTER INSERT ON taxonomy.outbox
FOR EACH ROW EXECUTE FUNCTION taxonomy.enqueue_catalog_delivery_h5();
