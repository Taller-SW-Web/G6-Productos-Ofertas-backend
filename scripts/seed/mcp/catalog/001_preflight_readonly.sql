-- Consultas solo lectura DATA-002
select count(*) products from catalog.products; select count(*) variants from catalog.variants; select count(*) sku_identity from catalog.sku_identity; select count(*) product_images from catalog.product_images; select count(*) variant_images from catalog.variant_images;
select p.id,p.nombre,p.sku_base,p.slug,p.tiene_variantes,p.estado,v.id,v.sku,si.product_id,si.variant_id from catalog.products p left join catalog.variants v on v.product_id=p.id left join catalog.sku_identity si on si.product_id=p.id or si.variant_id=v.id order by p.nombre,v.sku;
select id,sku,product_id,variant_id from catalog.sku_identity order by sku;
select id,nombre,estado from taxonomy.brands where estado='ACTIVO'; select id,nombre,estado from taxonomy.product_types where estado='ACTIVO'; select id,nombre,categoria_padre_id,estado from taxonomy.categories where estado='ACTIVO';
select c.nombre,cv.id,cv.nombre from taxonomy.characteristics c join taxonomy.characteristic_values cv on cv.caracteristica_id=c.id where c.estado='ACTIVO' and cv.estado='ACTIVO';
select pt.nombre,c.nombre,ptc.obligatoria,ptc.estado from taxonomy.product_type_characteristics ptc join taxonomy.product_types pt on pt.id=ptc.tipo_producto_id join taxonomy.characteristics c on c.id=ptc.caracteristica_id;
select name,mime_type,metadata->>'size' bytes from storage.objects where bucket_id='catalog-products';
select conrelid::regclass,conname,contype,pg_get_constraintdef(oid) from pg_constraint where connamespace='catalog'::regnamespace;
select event_object_table,trigger_name,event_manipulation,action_timing from information_schema.triggers where trigger_schema='catalog';
