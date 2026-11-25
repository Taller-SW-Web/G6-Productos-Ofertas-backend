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

  validateRollbackEvidence(validRollback, baseExpected);

  const tampered = structuredClone(validRollback);
  tampered.azSnapshots.after.policyXml = xmlDuring;
  assert.throws(() => validateRollbackEvidence(tampered, baseExpected), /SHA256 real de policyXml/);
});
