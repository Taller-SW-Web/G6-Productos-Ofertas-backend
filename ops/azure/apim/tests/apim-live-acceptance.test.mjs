#!/usr/bin/env node
/**
 * Pruebas unitarias locales (sin servicios externos ni Azure) para validar:
 * - R7-01: Modalidad A (external=false) y Modalidad B (external=true Allow-only) en ACA.
 * - R7-02: Evidencia de rollback APIM-T08 con XML real + SHA256 calculado + az apim / az rest --method get.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sha256Text,
  validateAcaIngressEvidence,
  validateRollbackEvidence,
  verifyLiveRollback,
} from './apim-live-acceptance.mjs';

const baseExpected = {
  subscriptionId: 'sub-test',
  resourceGroup: 'rg-test',
  environment: 'lab',
  gatewayResourceId: '/subscriptions/sub-test/resourceGroups/rg-test/providers/Microsoft.App/containerApps/api-gateway',
  apimResourceId: '/subscriptions/sub-test/resourceGroups/rg-test/providers/Microsoft.ApiManagement/service/apim-test',
  originCidrs: ['20.10.20.30/32'],
};

test('R7-01 ACA ingress accepts internal (external=false) and Allow-only external=true, rejects mixed Allow/Deny', () => {
  validateAcaIngressEvidence(
    {
      subscriptionId: 'sub-test',
      resourceGroup: 'rg-test',
      environment: 'lab',
      capturedAtUtc: new Date().toISOString(),
      sourceCommand: 'az containerapp show -n api-gateway -g rg-test',
      acaEnvironment: { vnetConfiguration: { infrastructureSubnetId: 'subnet-1' } },
      gatewayApp: {
        resourceId: baseExpected.gatewayResourceId,
        external: false,
        directRoutesBlocked: true,
      },
    },
    baseExpected,
  );

  validateAcaIngressEvidence(
    {
      subscriptionId: 'sub-test',
      resourceGroup: 'rg-test',
      environment: 'lab',
      capturedAtUtc: new Date().toISOString(),
      sourceCommand: 'az containerapp show -n api-gateway -g rg-test',
      acaEnvironment: { vnetConfiguration: null },
      gatewayApp: {
        resourceId: baseExpected.gatewayResourceId,
        external: true,
        ipSecurityRestrictions: [{ action: 'Allow', ipAddressRange: '20.10.20.30/32' }],
        directRoutesBlocked: true,
      },
    },
    baseExpected,
  );

  assert.throws(
    () =>
      validateAcaIngressEvidence(
        {
          subscriptionId: 'sub-test',
          resourceGroup: 'rg-test',
          environment: 'lab',
          capturedAtUtc: new Date().toISOString(),
          sourceCommand: 'az containerapp show -n api-gateway -g rg-test',
          acaEnvironment: { vnetConfiguration: null },
          gatewayApp: {
            resourceId: baseExpected.gatewayResourceId,
            external: true,
            ipSecurityRestrictions: [
              { action: 'Allow', ipAddressRange: '20.10.20.30/32' },
              { action: 'Deny', ipAddressRange: '0.0.0.0/0' },
            ],
            directRoutesBlocked: true,
          },
        },
        baseExpected,
      ),
    /mezclar Allow y Deny/,
  );
});

test('R7-02 rollback evidence verifies real policyXml SHA256 and az rest --method get snapshots', () => {
  const xmlBefore = '<policies><inbound><base /></inbound></policies>';
  const xmlDuring = '<policies><inbound><base /><set-header name="x-alt" /></inbound></policies>';
  const hashBefore = sha256Text(xmlBefore);
  const hashDuring = sha256Text(xmlDuring);

  const validRollback = {
    resourceId: baseExpected.apimResourceId,
    subscriptionId: baseExpected.subscriptionId,
    resourceGroup: baseExpected.resourceGroup,
    apiName: 'g6-productos-ofertas',
    revisionBefore: '1',
    alternativeRevision: '2',
    revisionAfterRollback: '1',
    previousState: 'rev1',
    alternativeAuthorizedState: 'rev2',
    previousPolicyHash: hashBefore,
    appliedPolicyHash: hashDuring,
    rollbackPolicyHash: hashBefore,
    restorationResult: 'RESTORED',
    postRollbackRoutesStatus: 'OK',
    timestamp: '2026-11-25T15:00:00Z',
    environment: 'lab',
    operationalApproval: 'CASTILLA-001',
    privateConnectivityCheck: 'PASS',
    postRollbackSmokeResult: 'PASS',
    azSnapshots: {
      before: {
        resourceId: baseExpected.apimResourceId,
        subscriptionId: baseExpected.subscriptionId,
        resourceGroup: baseExpected.resourceGroup,
        apiName: 'g6-productos-ofertas',
        revision: '1',
        policyXml: xmlBefore,
        policyHash: hashBefore,
        capturedAtUtc: '2026-11-25T14:55:00Z',
        sourceCommand: 'az rest --method get --url https://management.azure.com/subscriptions/sub-test/.../policies/policy',
      },
      during: {
        resourceId: baseExpected.apimResourceId,
        subscriptionId: baseExpected.subscriptionId,
        resourceGroup: baseExpected.resourceGroup,
        apiName: 'g6-productos-ofertas',
        revision: '2',
        policyXml: xmlDuring,
        policyHash: hashDuring,
        capturedAtUtc: '2026-11-25T14:57:00Z',
        sourceCommand: 'az apim api show --resource-group rg-test --service-name apim-test --api-id g6-productos-ofertas',
      },
      after: {
        resourceId: baseExpected.apimResourceId,
        subscriptionId: baseExpected.subscriptionId,
        resourceGroup: baseExpected.resourceGroup,
        apiName: 'g6-productos-ofertas',
        revision: '1',
        policyXml: xmlBefore,
        policyHash: hashBefore,
        capturedAtUtc: '2026-11-25T14:59:00Z',
        sourceCommand: 'az rest --method get --url https://management.azure.com/subscriptions/sub-test/.../policies/policy',
      },
    },
  };

  const evalPrepared = validateRollbackEvidence(validRollback, baseExpected);
  assert.equal(evalPrepared.status, 'EVIDENCE_PREPARED');
  assert.equal(evalPrepared.verified, false);

  // Negativo R10: falsificar azAcquisitionVerified/independentQueryDigest en el JSON NO produce PASS
  const selfDeclared = {
    ...validRollback,
    azAcquisitionVerified: true,
    independentQueryDigest: 'a'.repeat(64),
  };
  const evalSelfDeclared = validateRollbackEvidence(selfDeclared, baseExpected);
  assert.equal(evalSelfDeclared.status, 'EVIDENCE_PREPARED');
  assert.equal(evalSelfDeclared.verified, false);

  const tampered = structuredClone(validRollback);
  tampered.azSnapshots.after.policyXml = xmlDuring;
  assert.throws(() => validateRollbackEvidence(tampered, baseExpected), /SHA256 real de policyXml/);
});

test('APIM-T08 live verification rejects dangerous identifiers, wrong revision, hash mismatch, and emits NOT_VERIFIED without transition evidence', () => {
  const xmlBefore = '<policies><inbound><base /></inbound></policies>\n';
  const xmlDuring = '<policies><inbound><base /><set-header name="x-alt" /></inbound></policies>';
  const hashBefore = sha256Text(xmlBefore);
  const hashDuring = sha256Text(xmlDuring);

  const baseRollback = {
    resourceId: baseExpected.apimResourceId,
    subscriptionId: baseExpected.subscriptionId,
    resourceGroup: baseExpected.resourceGroup,
    apiName: 'g6-productos-ofertas',
    revisionBefore: '1',
    alternativeRevision: '2',
    revisionAfterRollback: '1',
    previousState: 'rev1',
    alternativeAuthorizedState: 'rev2',
    previousPolicyHash: hashBefore,
    appliedPolicyHash: hashDuring,
    rollbackPolicyHash: hashBefore,
    restorationResult: 'RESTORED',
    postRollbackRoutesStatus: 'OK',
    timestamp: '2026-11-25T15:00:00Z',
    environment: 'lab',
    operationalApproval: 'CASTILLA-001',
    privateConnectivityCheck: 'PASS',
    postRollbackSmokeResult: 'PASS',
    azSnapshots: {
      before: {
        resourceId: baseExpected.apimResourceId,
        subscriptionId: baseExpected.subscriptionId,
        resourceGroup: baseExpected.resourceGroup,
        apiName: 'g6-productos-ofertas',
        revision: '1',
        policyXml: xmlBefore,
        policyHash: hashBefore,
        capturedAtUtc: '2026-11-25T14:55:00Z',
        sourceCommand: 'az rest --method get --url https://management.azure.com/subscriptions/sub-test/.../policies/policy',
      },
      during: {
        resourceId: baseExpected.apimResourceId,
        subscriptionId: baseExpected.subscriptionId,
        resourceGroup: baseExpected.resourceGroup,
        apiName: 'g6-productos-ofertas',
        revision: '2',
        policyXml: xmlDuring,
        policyHash: hashDuring,
        capturedAtUtc: '2026-11-25T14:57:00Z',
        sourceCommand: 'az rest --method get --url https://management.azure.com/subscriptions/sub-test/.../policies/policy',
      },
      after: {
        resourceId: baseExpected.apimResourceId,
        subscriptionId: baseExpected.subscriptionId,
        resourceGroup: baseExpected.resourceGroup,
        apiName: 'g6-productos-ofertas',
        revision: '1',
        policyXml: xmlBefore,
        policyHash: hashBefore,
        capturedAtUtc: '2026-11-25T14:59:00Z',
        sourceCommand: 'az rest --method get --url https://management.azure.com/subscriptions/sub-test/.../policies/policy',
      },
    },
  };

  // 1. Negativo: identificadores peligrosos (no debe invocar runAzRead)
  for (const badApi of ['g6;whoami', 'g6/../../other', 'g6 $(id)', 'g6`id`']) {
    const badRollback = structuredClone(baseRollback);
    badRollback.apiName = badApi;
    badRollback.azSnapshots.before.apiName = badApi;
    badRollback.azSnapshots.during.apiName = badApi;
    badRollback.azSnapshots.after.apiName = badApi;
    let called = false;
    assert.throws(
      () =>
        verifyLiveRollback({
          rollback: badRollback,
          expected: { ...baseExpected, revision: '1' },
          runAzRead: () => {
            called = true;
            return {};
          },
        }),
      /apiName inválido o peligroso/,
    );
    assert.equal(called, false);
  }

  for (const badRev of ['1;rev=2', '1/../../2', '1 && echo']) {
    const badRollback = structuredClone(baseRollback);
    badRollback.revisionAfterRollback = badRev;
    badRollback.azSnapshots.after.revision = badRev;
    let called = false;
    assert.throws(
      () =>
        verifyLiveRollback({
          rollback: badRollback,
          expected: { ...baseExpected, revision: '1' },
          runAzRead: () => {
            called = true;
            return {};
          },
        }),
      /inválida o peligrosa/,
    );
    assert.equal(called, false);
  }

  // 2. Negativo: revisión incorrecta
  assert.throws(
    () =>
      verifyLiveRollback({
        rollback: baseRollback,
        expected: { ...baseExpected, revision: '3' },
        runAzRead: () => ({}),
      }),
    /revisión exacta esperada/,
  );

  // 3. Negativo: hash distinto (incluyendo diferencia de salto de línea que trim() ocultaría)
  assert.throws(
    () =>
      verifyLiveRollback({
        rollback: baseRollback,
        expected: { ...baseExpected, revision: '1' },
        runAzRead: (args) => {
          const url = args[args.indexOf('--url') + 1];
          assert.ok(url.includes('/apis/g6-productos-ofertas;rev=1/policies/policy'));
          return { properties: { value: xmlBefore.trimEnd() } };
        },
      }),
    /hash real consultado en Azure difiere/,
  );

  const mockAzSuccess = (calledUrls) => (args) => {
    assert.equal(args[0], 'rest');
    assert.equal(args[args.indexOf('--method') + 1], 'get');
    const url = args[args.indexOf('--url') + 1];
    calledUrls.push(url);
    if (url.includes('/policies/policy')) {
      return { properties: { value: xmlBefore } };
    }
    if (url.includes('/revisions?')) {
      return { value: [{ apiRevision: '1' }, { apiRevision: '2' }] };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  // 4. Negativo: hash final correcto pero sin evidencia independiente de transición -> NOT_VERIFIED
  const urlsNoTrans = [];
  const noTransRes = verifyLiveRollback({
    rollback: baseRollback,
    expected: { ...baseExpected, revision: '1' },
    runAzRead: mockAzSuccess(urlsNoTrans),
    independentTransitions: null,
  });
  assert.equal(noTransRes.status, 'NOT_VERIFIED');
  assert.equal(noTransRes.verified, false);
  assert.ok(urlsNoTrans.some((u) => u.includes('/apis/g6-productos-ofertas;rev=1/policies/policy')));

  // 5. Positivo: revisión exacta + XML exacto sin trim + transiciones independientes verificables -> PASS
  const urlsValid = [];
  const passRes = verifyLiveRollback({
    rollback: baseRollback,
    expected: { ...baseExpected, revision: '1' },
    runAzRead: mockAzSuccess(urlsValid),
    independentTransitions: {
      before: { revision: '1', policyHash: hashBefore, capturedAtUtc: '2026-11-25T14:55:00Z' },
      during: { revision: '2', policyHash: hashDuring, capturedAtUtc: '2026-11-25T14:57:00Z' },
      after: { revision: '1', policyHash: hashBefore, capturedAtUtc: '2026-11-25T14:59:00Z' },
    },
  });
  assert.equal(passRes.status, 'PASS');
  assert.equal(passRes.verified, true);
  assert.ok(urlsValid.some((u) => u.includes('/apis/g6-productos-ofertas;rev=1/policies/policy')));
  assert.ok(urlsValid.some((u) => u.includes('/apis/g6-productos-ofertas/revisions?')));
});
