-- Verificacion posterior del lote DATA-002. Solo lectura; falla ante drift o faltantes.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
DO $check$
DECLARE
    product_ids uuid[] := ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[];
BEGIN
    IF (SELECT count(*) FROM catalog.products WHERE id = ANY(product_ids)) <> 15 THEN
        RAISE EXCEPTION 'DATA-002: conteo de productos incorrecto';
    END IF;
    IF (SELECT count(*) FROM catalog.variants WHERE product_id = ANY(product_ids)) <> 45 THEN
        RAISE EXCEPTION 'DATA-002: conteo de variantes incorrecto';
    END IF;
    IF (SELECT count(*) FROM catalog.product_identifying_characteristics WHERE product_id = ANY(product_ids)) <> 24 THEN
        RAISE EXCEPTION 'DATA-002: caracteristicas identificadoras incorrectas';
    END IF;
    IF (SELECT count(*) FROM catalog.variant_attribute_values a JOIN catalog.variants v ON v.id = a.variant_id WHERE v.product_id = ANY(product_ids)) <> 90 THEN
        RAISE EXCEPTION 'DATA-002: atributos de variante incorrectos';
    END IF;
    IF (SELECT count(*) FROM catalog.product_attribute_values WHERE product_id = ANY(product_ids)) <> 6 THEN
        RAISE EXCEPTION 'DATA-002: atributos de producto simple incorrectos';
    END IF;
    IF (SELECT count(*) FROM catalog.variant_images i JOIN catalog.variants v ON v.id = i.variant_id WHERE v.product_id = ANY(product_ids)) <> 45 OR
       (SELECT count(*) FROM catalog.product_images WHERE product_id = ANY(product_ids)) <> 3 THEN
        RAISE EXCEPTION 'DATA-002: imagenes asociadas incorrectas';
    END IF;
    IF (SELECT count(DISTINCT url) FROM (
        SELECT i.url FROM catalog.variant_images i JOIN catalog.variants v ON v.id = i.variant_id WHERE v.product_id = ANY(product_ids)
        UNION ALL SELECT url FROM catalog.product_images WHERE product_id = ANY(product_ids)
    ) image_urls) <> 17 THEN
        RAISE EXCEPTION 'DATA-002: archivos de imagen asociados incorrectos';
    END IF;
    IF (SELECT count(*) FROM catalog.sku_identity s WHERE s.variant_id IN (
        SELECT id FROM catalog.variants WHERE product_id = ANY(product_ids)
    ) OR s.product_id IN ('ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '2ee6399e-2333-5916-847b-f6d2a0f03527', '8111028a-4a0e-5cb1-a4b8-8095cc098a83')) <> 48 THEN
        RAISE EXCEPTION 'DATA-002: identidades SKU vendibles incorrectas';
    END IF;
    IF EXISTS (SELECT 1 FROM catalog.variant_attribute_values a JOIN catalog.variants v ON v.id = a.variant_id
        WHERE v.product_id = ANY(product_ids) AND (a.valor IS NULL OR jsonb_typeof(a.valor) <> 'object' OR a.valor->>'valor_id' IS DISTINCT FROM a.valor_id)) OR
       EXISTS (SELECT 1 FROM catalog.product_attribute_values a WHERE a.product_id = ANY(product_ids)
        AND (a.valor IS NULL OR jsonb_typeof(a.valor) <> 'object' OR a.valor->>'valor_id' IS DISTINCT FROM a.valor_id)) THEN
        RAISE EXCEPTION 'DATA-002: representacion JSONB de atributos incorrecta';
    END IF;
    IF EXISTS (SELECT 1 FROM catalog.variants v CROSS JOIN LATERAL (
        SELECT jsonb_object_agg(a.caracteristica_id, jsonb_build_object('valor_id', a.valor_id)) AS derived_key
        FROM catalog.variant_attribute_values a WHERE a.variant_id = v.id AND a.es_identificador
    ) a WHERE v.product_id = ANY(product_ids) AND v.identifying_key IS DISTINCT FROM a.derived_key) THEN
        RAISE EXCEPTION 'DATA-002: identifying_key no coincide con fn_assert_product';
    END IF;
    IF EXISTS (SELECT 1 FROM catalog.variants v WHERE v.product_id = ANY(product_ids) AND NOT EXISTS (SELECT 1 FROM catalog.variant_images i WHERE i.variant_id = v.id)) THEN
        RAISE EXCEPTION 'DATA-002: variante sin imagen';
    END IF;
END
$check$;
SELECT
    (SELECT count(*) FROM catalog.products WHERE id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) AS productos,
    (SELECT count(*) FROM catalog.variants WHERE product_id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) AS variantes,
    (SELECT count(*) FROM catalog.variant_attribute_values a JOIN catalog.variants v ON v.id = a.variant_id WHERE v.product_id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) AS atributos_variante,
    (SELECT count(*) FROM catalog.product_attribute_values WHERE product_id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) AS atributos_producto,
    (SELECT count(*) FROM catalog.sku_identity s WHERE s.variant_id IN (SELECT id FROM catalog.variants WHERE product_id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) OR s.product_id IN ('ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '2ee6399e-2333-5916-847b-f6d2a0f03527', '8111028a-4a0e-5cb1-a4b8-8095cc098a83')) AS sku_vendibles,
    (SELECT count(*) FROM catalog.variant_images i JOIN catalog.variants v ON v.id = i.variant_id WHERE v.product_id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) AS imagenes_variante,
    (SELECT count(*) FROM catalog.product_images WHERE product_id = ANY(ARRAY['96c6972f-2bd2-5528-8028-5293fe719db9', '8be3020b-0f9c-5343-ad74-41740393bece', 'ad478840-d9fa-5c02-8e4f-d6bdbd0b1914', '9d5e65cb-10c9-5a2b-a69d-090e3208bd77', '457f749f-2aaf-56a3-9776-a95df5d24d59', '59022191-2fb1-5db3-903f-05f8e6be19b1', '536287fd-b2fa-5c1d-a086-7db284725485', '2ee6399e-2333-5916-847b-f6d2a0f03527', 'ff8e9b30-f939-51cd-9294-4753cdae05b8', 'b8224b4b-8268-57e4-9d61-d4424828544c', '0f9cc95c-6502-54ce-82d5-72f192bbd33c', '79c03413-cf12-56fe-bcd1-32e45cf40221', '7b1abfe1-87c2-5e60-81dc-cfb6daf247cc', '8111028a-4a0e-5cb1-a4b8-8095cc098a83', '858ed760-beb9-5fdf-aa6d-b6b543b162d2']::uuid[])) AS imagenes_producto;
ROLLBACK;
