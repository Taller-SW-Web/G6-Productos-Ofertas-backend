-- Candidata para validacion local; no es una migracion productiva aprobada.
-- La futura operacion productiva requiere SELECT para el rol runtime de Catalog
-- y una via administrativa controlada para establecer o revocar habilitaciones.
CREATE TABLE catalog.sku_channel_eligibility (
    sku text NOT NULL,
    canal text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,

    CONSTRAINT pk_sku_channel_eligibility
        PRIMARY KEY (sku, canal),

    CONSTRAINT fk_sku_channel_eligibility_sku
        FOREIGN KEY (sku)
        REFERENCES catalog.sku_identity(sku)
        ON DELETE RESTRICT,

    CONSTRAINT ck_sku_channel_eligibility_canal
        CHECK (
            canal IN (
                'MARKETPLACE',
                'CHATBOT',
                'RETAIL',
                'VENTAS'
            )
        )
);
