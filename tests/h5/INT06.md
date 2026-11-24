# INT-06 — Taxonomy / Catalog

Las pruebas ejecutan servicios de `master` con datos sintéticos y PostgreSQL desechable; no acreditan un entorno desplegado ni permisos G7/Azure reales. El SQL entre ambos schemas se usa únicamente desde el administrador de la fixture para preparar y verificar datos; cada runtime conserva su propio acceso.

Requisitos: `npm ci`, Docker, y checkout de Docs correspondiente a `c9e1e5c217616d28229fccf5315fb97a1ae061a9`. Por defecto se busca un repositorio Docs hermano; alternativamente configurar `G6_E2E_DOCS_PATH`. El runner comprueba SHA-256 del AsyncAPI rc.3 y de la migración base de prueba antes de ejecutar los casos que los necesitan.

```sh
node tests/h5/run-int06.mjs read
node tests/h5/run-int06.mjs deactivate
node tests/h5/run-int06.mjs contract
node tests/h5/run-int06.mjs barrier
node tests/h5/run-int06.mjs azure
node tests/h5/run-int06.mjs all
```

Las dos suites HTTP reutilizan el harness PostgreSQL de Taxonomy existente, que incluye JWT RSA de prueba y las rutas administrativas. Las suites contractuales verifican el AsyncAPI oficial; la barrera ejecuta Category y Brand con referencia activa y después liberada, Inbox/Outbox, duplicados y respuestas tardías. `all` comparte una ejecución del harness HTTP entre las dos suites, pero cada modo puede volver a ejecutarse por separado.

Para escribir JSON, establecer `G6_INT06_EVIDENCE_PATH` y `G6_INT06_MANIFEST_PATH` como rutas de salida elegidas por el operador. Los artefactos no incluyen URLs de base, credenciales ni rutas locales. Una prueba sin resultado, con casos omitidos o cuyo número sea inferior al mínimo se marca `INCONCLUSIVE`, no PASS. El SHA del commit y el fingerprint de las fuentes permiten identificar un árbol con cambios sin commit.

`azure` es un detector de puerta, no ejecuta Azure: devuelve `BLOCKED_SB / L2_PENDING` y código 2. Owner Axel y el equipo Azure deben aportar el runtime y el procedimiento L2 autorizados, RBAC Sender/Receiver, un ambiente y dataset aislados; después se debe ejecutar y registrar la prueba real con su SHA/digest. Esta rama no provisiona recursos ni envía mensajes a un bus real.
