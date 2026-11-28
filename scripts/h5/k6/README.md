# k6 H5 — arnés HTTP de lectura

Ejecución local, resultados saneados y comparación reproducible para PERF-01, PERF-02 y PERF-03. Las cargas de este arnés son GET. Las suites históricas, los fixtures de sus propietarios y los workflows de CI/CD conservan sus interfaces.

| Caso | Ruta medida | Cobertura reutilizada | Alcance local |
|---|---|---|---|
| PERF-01 · Catálogo | `GET /api/v1/productos` | Fixture/oráculo de paginación de Catálogo y clasificador HTTP compartido. El script canónico conserva la verificación adicional de detalle y SKU vendible. | HTTP de fixture, listado de páginas e integridad semántica. |
| PERF-02 · Pricing | `GET /api/v1/precios/skus/{sku}` | Controlador, guard JWT y resolución de precio de Pricing. | HTTP de Nest real; emisor/JWKS sintéticos, doble del contexto Catálogo y doble del repositorio de precios. Sin Gateway ni PostgreSQL. |
| PERF-03 · Inventario | `GET /api/v1/inventario/disponibilidad/comercial` | Módulo, guard JWT y reglas reales, más grupos del manifest canónico con hash verificado. El arnés existente conserva el reparto por SKU y su verificación POST informativa. | HTTP de Nest real; JWT de fixture, almacén en memoria y workers desactivados. Sin Gateway ni PostgreSQL. |

## PowerShell desde la raíz de Backend

Requiere Node/npm del proyecto, dependencias instaladas, Windows PowerShell o PowerShell 7 y [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/). El binario puede ser portátil.

~~~powershell
$K6 = (Get-Command k6 -CommandType Application).Source
$Backend = git rev-parse HEAD
$Frontend = git -C '<checkout de Frontend>' rev-parse origin/master
$Docs = git -C '<checkout de Docs>' rev-parse origin/master

.\scripts\h5\k6\tests\validar-arnes.ps1 -K6Path $K6
node --test scripts/h5/k6/tests/seguridad.test.mjs
node scripts/h5/k6/tests/verificar-evidencia.mjs
node scripts/h5/k6/bin/demo-local.mjs apps/catalog-svc/test/performance/h5/catalog-pagination.fixture-server.h5.mjs $Backend $Frontend $Docs $K6 --dashboard

node node_modules/typescript/bin/tsc --project scripts/h5/k6/tests/tsconfig.local.json
node scripts/h5/k6/.local/build/scripts/h5/k6/tests/servicios-locales.js $Frontend $Docs $K6 PERF-02
node scripts/h5/k6/.local/build/scripts/h5/k6/tests/servicios-locales.js $Frontend $Docs $K6 PERF-03
~~~

Los tres smokes usan 1 VU durante 60 s y un máximo de 2 RPS sobre `127.0.0.1`. Los servidores de prueba usan puertos efímeros. Los helpers generan credenciales sintéticas de proceso y cierran sus listeners. En Catálogo, `--validar` limita el comando a preflight y controles sin tráfico; `--dashboard` abre el dashboard nativo en `http://127.0.0.1:5665` durante la medición. Cierra esa pestaña al terminar. Los runners exportan el HTML aun cuando el dashboard en vivo no se abrió, si la versión de k6 admite la función.

## Perfiles y seguridad

| Perfil | VU | Duración | Techo del arnés |
|---|---:|---:|---:|
| `demo-smoke` | 1 | 60 s | 5 RPS en staging y 2 en loopback |
| `demo-normal` | 5 | 180 s | 10 RPS en staging |
| `formal-carga` | 20 | 300 s | 20 RPS en staging, sujeto formal y opt-in |

Los techos son guardas del cliente; la tasa autorizada puede ser menor. Los perfiles mayores se validan con `k6 inspect` sin tráfico. Ejecuta pruebas de staging solo con el wrapper y un [permiso verificable](config/STAGING.md) emitido por Infra y G7. Guarda el permiso y la configuración privada en `scripts/h5/k6/.local/` e inyecta `G6_K6_TARGET` y `G6_K6_TEST_TOKEN` desde el gestor autorizado. La revisión de cada 200 debe coincidir con la firmada. Los tokens no se pasan por argumentos ni se agregan a reportes. El preflight HTTP verifica la respuesta antes de medir y desactiva redirecciones. Un 401/403/429 inesperado interrumpe la demo. Las tasas sostenidas de error y el vencimiento de ventana también interrumpen la carga. Las negativas explícitas se contabilizan aparte.

~~~powershell
$Directory = (Resolve-Path 'scripts/h5/k6/.local').Path
$Common = @{
    Config = Join-Path $Directory 'config.json'
    Dataset = Join-Path $Directory 'dataset.json'
    Manifest = Join-Path $Directory 'release.json'
    ComparisonContext = Join-Path $Directory 'contexto.json'
    Authorization = Join-Path $Directory 'permiso-staging.json'
    K6Path = $K6
}
.\scripts\h5\k6\bin\ejecutar-demo.ps1 @Common -Profile demo-smoke -SoloValidar
.\scripts\h5\k6\bin\ejecutar-demo.ps1 @Common -Profile demo-smoke -Dashboard
.\scripts\h5\k6\bin\ejecutar-demo.ps1 @Common -Profile demo-normal -Dashboard
~~~

## Evidencia, comparación y CI

- `.local/<id>/summary.json` incluye commit y árbol de Git, hashes de los módulos (incluido el oráculo importado de Catálogo), dataset, perfil y métricas. `summary.sha256` verifica sus bytes. CSV y dashboard HTML quedan en la misma carpeta ignorada. La evidencia L1 saneada está en [evidence/local](evidence/local/). Ver [formato y telemetría](evidence/README.md).
- El gate por corrida exige 100% de invariantes críticos de 2xx, <1% de errores inesperados y resultado completo. Para comparar formalmente, usa `-Subject baseline|candidato` y `-Repetition 1|2|3` con cada perfil aprobado. Mantén mismo dataset y condiciones comparables. `comparar-corridas.ps1 -Baseline $Base -Candidato $Candidate -Telemetria $Dir` verifica procedencia Git, bytes originales de telemetría, sujeto, intervalo y gates. Si los intentos por segundo alcanzan al menos el 95% del techo del cliente, el gate de RPS queda sin evaluar; un `PASS` de un perfil fijo tampoco acredita capacidad máxima.
- Después del merge de Backend #310, sincroniza la rama y prueba los mismos entrypoints en el runner de GitHub Actions. La integración propuesta usa `workflow_dispatch` con selección explícita de caso/perfil, origen y secretos desde un environment protegido, un grupo de concurrencia por ambiente y artefactos saneados. La primera prueba del workflow debe usar loopback y los permisos mínimos; Azure queda sujeto a aprobación. Las cargas prolongadas requieren disparo manual y autorización.
- Promotions, las pruebas APIM/RL y el perfil oficial combinado de Inventario conservan sus arneses actuales. La demo GET y sus resultados no acreditan despliegue, homologación, rendimiento productivo o H5-03.
