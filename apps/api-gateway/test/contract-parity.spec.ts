import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { G5_H5_ROUTES } from '../src/routing/g5-h5-routes.js';

interface ContractSnapshot {
  docsSha: string;
  openApiVersion: string;
  approvalStatus: string;
  operationCount: number;
  operations: {
    method: string;
    path: string;
    operationId: string;
    service: string | null;
    security: string[];
    scope: string | null;
    audience: string | null;
    clients: string[] | null;
    role: string | null;
    introspection: boolean;
    headers: {
      name: string;
      required: boolean;
      minLength: number | null;
      maxLength: number | null;
    }[];
    requestTypes: string[];
    responses: Record<
      string,
      { types: string[]; codes: string[]; headers: string[] }
    >;
    internal: boolean;
    runtimeStatus: string | null;
    errorCodesDeclared: boolean;
  }[];
}

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/openapi-0.7.0-rc.3.parity.json', import.meta.url),
    ),
    'utf8',
  ),
) as ContractSnapshot;

const internalOperationIds = [
  'obtenerContextoSku',
  'obtenerContextosSkuLote',
  'filtrarSkusVendiblesInterno',
  'obtenerEvidenciaReservaCuponInterno',
  'obtenerContenidoCargaMasivaInternoH5',
];
const pendingProviderOperationIds = [
  'listarAlertasOperativasInventario',
  'listarUbicacionesInventario',
];
const legacyPricingOperationIds = [
  'obtenerDefinicionPrecioProductoAdministracion',
  'obtenerDefinicionPrecioSkuAdministracion',
];
const missingPublicOperationIds = [...pendingProviderOperationIds];
const missingErrorCodeMetadataOperationIds = [
  'listarSaldosFisicosAdministracion',
  'listarAlertasOperativasInventario',
  'listarUbicacionesInventario',
  'listarTrasladosInventario',
  'obtenerTrasladoInventario',
  'filtrarSkusVendiblesInterno',
  'obtenerEvidenciaReservaCuponInterno',
];
const h5OperationIds = [
  'admitirConsumoCuponH5',
  'admitirRestauracionCuponH5',
  'obtenerOperacionCuponH5',
  'obtenerEstadoReservaH5',
];
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function routeMetadata(route: (typeof CONTRACT_ROUTES)[number]) {
  return {
    method: route.method,
    path: route.path,
    operationId: route.operationId,
    service: route.service,
    security: sorted(route.security),
    scope: route.scope ?? null,
    audience: route.audience ?? null,
    clients: route.clients ? sorted(route.clients) : null,
    role: route.role ?? null,
    introspection: route.introspection,
    headers: route.headers
      .map((header) => ({
        name: header.name.toLowerCase(),
        required: header.required,
        minLength: header.minLength ?? null,
        maxLength: header.maxLength ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    requestTypes: sorted(route.requestTypes),
    responses: Object.fromEntries(
      Object.entries(route.responses).map(([status, response]) => [
        status,
        {
          types: sorted(response.types),
          codes: sorted(response.codes),
          headers: sorted(
            response.headers.map((header) => header.toLowerCase()),
          ),
        },
      ]),
    ),
  };
}

describe('Gateway parity with the pinned H5 OpenAPI snapshot', () => {
  it('uses the latest internally approved Docs snapshot and its full inventory', () => {
    expect(snapshot).toMatchObject({
      docsSha: '61726e2db227a8763fbea6d9cc055651804661c4',
      openApiVersion: '0.7.0-rc.3',
      approvalStatus: 'APPROVED_G6',
      operationCount: 154,
    });
    expect(snapshot.operations).toHaveLength(snapshot.operationCount);
    expect(CONTRACT_ROUTES).toHaveLength(145);
    expect(G5_H5_ROUTES).toHaveLength(4);
    expect(
      new Set(snapshot.operations.map((operation) => operation.operationId))
        .size,
    ).toBe(snapshot.operationCount);
  });

  it('matches all registered route metadata and classifies every other operation', () => {
    const contractById = new Map(
      snapshot.operations.map((operation) => [
        operation.operationId,
        operation,
      ]),
    );
    const baseIds = CONTRACT_ROUTES.map((route) => route.operationId);
    const h5Ids = G5_H5_ROUTES.map((route) => route.operationId);
    const registeredIds = [...baseIds, ...h5Ids];

    expect(new Set(baseIds).size).toBe(baseIds.length);
    expect(new Set(h5Ids).size).toBe(h5Ids.length);
    expect(baseIds.filter((id) => h5Ids.includes(id))).toEqual([]);
    expect(new Set(registeredIds).size).toBe(registeredIds.length);

    const metadataMismatches: { operationId: string; fields: string[] }[] = [];
    for (const route of [...CONTRACT_ROUTES, ...G5_H5_ROUTES]) {
      const operation = contractById.get(route.operationId);
      if (!operation && legacyPricingOperationIds.includes(route.operationId)) {
        expect(route.security).toEqual(['userBearer']);
        expect(route.role).toBe('GESTOR_COMERCIAL');
        continue;
      }
      expect(
        operation,
        `Missing Docs operation ${route.operationId}`,
      ).toBeDefined();
      const expectedMetadata = {
        method: operation!.method,
        path: operation!.path,
        operationId: operation!.operationId,
        service: operation!.service,
        security: sorted(operation!.security),
        scope: operation!.scope,
        audience: operation!.audience,
        clients: operation!.clients ? sorted(operation!.clients) : null,
        role: operation!.role,
        introspection: operation!.introspection,
        headers: operation!.headers
          .map((header) => ({
            name: header.name.toLowerCase(),
            required: header.required,
            minLength: header.minLength,
            maxLength: header.maxLength,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        requestTypes: sorted(operation!.requestTypes),
        responses: Object.fromEntries(
          Object.entries(operation!.responses).map(([status, response]) => [
            status,
            {
              types: sorted(response.types),
              codes: sorted(response.codes),
              headers: sorted(response.headers),
            },
          ]),
        ),
      };
      const actualMetadata = routeMetadata(route);
      const fields = Object.keys(expectedMetadata).filter(
        (field) =>
          JSON.stringify(
            actualMetadata[field as keyof typeof actualMetadata],
          ) !==
          JSON.stringify(
            expectedMetadata[field as keyof typeof expectedMetadata],
          ),
      );
      if (fields.length)
        metadataMismatches.push({ operationId: route.operationId, fields });
    }
    expect(metadataMismatches).toEqual([]);

    expect(sorted(h5Ids)).toEqual(sorted(h5OperationIds));
    expect(
      sorted(internalOperationIds.filter((id) => registeredIds.includes(id))),
    ).toEqual([]);
    expect(
      sorted(
        snapshot.operations
          .filter((operation) => operation.internal)
          .map((operation) => operation.operationId),
      ),
    ).toEqual(sorted(internalOperationIds));
    expect(
      sorted(
        snapshot.operations
          .filter((operation) => !operation.errorCodesDeclared)
          .map((operation) => operation.operationId),
      ),
    ).toEqual(sorted(missingErrorCodeMetadataOperationIds));
    for (const route of [...CONTRACT_ROUTES, ...G5_H5_ROUTES]) {
      const operation = contractById.get(route.operationId);
      if (!operation) {
        expect(legacyPricingOperationIds).toContain(route.operationId);
        continue;
      }
      if (!operation.errorCodesDeclared)
        expect(
          Object.values(route.responses).every(
            (response) => response.codes.length === 0,
          ),
        ).toBe(true);
    }

    const legacyRoutes = CONTRACT_ROUTES.filter((route) =>
      legacyPricingOperationIds.includes(route.operationId),
    );
    expect(sorted(legacyRoutes.map((route) => route.operationId))).toEqual(
      sorted(legacyPricingOperationIds),
    );
    for (const route of legacyRoutes) {
      expect(route.security).toEqual(['userBearer']);
      expect(route.role).toBe('GESTOR_COMERCIAL');
    }

    const missingIds = snapshot.operations
      .map((operation) => operation.operationId)
      .filter(
        (id) =>
          !registeredIds.includes(id) && !internalOperationIds.includes(id),
      );
    expect(sorted(missingIds)).toEqual(sorted(missingPublicOperationIds));
    expect(missingIds).toHaveLength(2);
    expect(
      snapshot.operations
        .filter((operation) =>
          pendingProviderOperationIds.includes(operation.operationId),
        )
        .every(
          (operation) => operation.runtimeStatus === 'PENDIENTE_ENDPOINT_HTTP',
        ),
    ).toBe(true);
  });

  it('does not register duplicate method and parameter-pattern pairs', () => {
    const keys = [...CONTRACT_ROUTES, ...G5_H5_ROUTES].map(
      (route) => `${route.method} ${route.path.replace(/\{[^}]+\}/g, '{}')}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
