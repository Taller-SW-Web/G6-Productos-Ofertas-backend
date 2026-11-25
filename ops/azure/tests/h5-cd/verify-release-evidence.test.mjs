import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHILE_POLICY,
  evaluateCdEvidence,
} from './verify-release-evidence.mjs';

function castillaReviewer() {
  return {
    type: 'User',
    id: 143348512,
    login: 'mrcastilla8',
  };
}

function evidence({ selfApproved = false } = {}) {
  const sha = 'a'.repeat(40);
  const digest = 'sha256:' + 'b'.repeat(64);
  const service = 'catalog-svc';
  const origin =
    'https://catalog-svc.internal.chilecentral.azurecontainerapps.io';
  const prefix =
    'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/' + service + '@';
  const reviewer = castillaReviewer();
  return {
    destination: 'chile-shared',
    repo: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    ref: 'refs/heads/master',
    source_sha: sha,
    master_sha: sha,
    head_verified: true,
    service,
    run_id: '12345',
    image: { source_sha: sha, reference: prefix + digest },
    receipt: {
      destination: 'chile-shared',
      github_environment: 'azure-h5-chile',
      aca_environment: 'env-g6-phase1-chile',
      app_resource_id:
        '/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/rg-g6-aca-chile/providers/Microsoft.App/containerApps/' +
        service,
      run_id: '12345',
      source_sha: sha,
      service,
      target: prefix + digest,
      origin,
      served_digest: digest,
      served_revision: 'catalog-svc--candidate',
      traffic_weight: 100,
      previous_image: prefix + 'sha256:' + 'c'.repeat(64),
      previous_revision: 'catalog-svc--previous',
    },
    environment: {
      destination: 'chile-shared',
      name: 'azure-h5-chile',
      approval_verified: true,
      approval_run_id: '12345',
      reviewers: [reviewer],
      approved_by: reviewer,
      triggered_by: selfApproved
        ? reviewer
        : { type: 'User', id: 999999, login: 'AXL031' },
      self_approved: selfApproved,
      prevent_self_review: false,
      admin_bypass: false,
      custom_branch_policies: true,
      protected_branches: false,
      branch_policy_type: 'branch',
      allowed_branches: ['master'],
    },
    oidc: {
      method: 'oidc',
      run_id: '12345',
      persistent_credentials: false,
      federated_environment: 'azure-h5-chile',
    },
    audit: {
      source_sha: sha,
      exit_code: 0,
      lock_sha256: 'a'.repeat(64),
      report_sha256: 'b'.repeat(64),
      report: { metadata: { vulnerabilities: { high: 0, critical: 0 } } },
    },
    smoke: {
      run_id: '12345',
      origin,
      liveness: { http_status: 200, body: { service, status: 'ok' } },
      readiness: { http_status: 200, body: { service, status: 'ready' } },
      unauthenticated_status: 401,
    },
  };
}

function checkFailure(caseId, mutate) {
  const record = evidence();
  mutate(record);
  const result = evaluateCdEvidence(record);
  assert.equal(result.execution_result, 'FAIL');
  assert.equal(
    result.checks.find((entry) => entry.case_id === caseId).execution_result,
    'FAIL',
  );
}

// Matches the JSON written by deploy.sh after verifying 100% of Chile traffic.
function officialReceipt(record) {
  return {
    service: record.service,
    destination: 'chile-shared',
    github_environment: 'azure-h5-chile',
    workflow_run_id: record.run_id,
    resource_group: 'rg-g6-aca-chile',
    aca_environment: 'env-g6-phase1-chile',
    location: 'Chile Central',
    subscription_id: CHILE_POLICY.subscription_id,
    app_resource_id: record.receipt.app_resource_id,
    container: record.service,
    previous: record.receipt.previous_image,
    target: record.image.reference,
    digest_candidate: record.image.reference.split('@')[1],
    origin_https: record.smoke.origin,
    config_sha256: 'd'.repeat(64),
    served_revision: record.receipt.served_revision,
    served_digest: record.receipt.served_digest,
    traffic_weight: 100,
  };
}

test('loads official Chile policy from deployment-targets.json and verify-environment-protection.sh', () => {
  assert.equal(CHILE_POLICY.destination, 'chile-shared');
  assert.equal(CHILE_POLICY.github_environment, 'azure-h5-chile');
  assert.equal(CHILE_POLICY.aca_environment, 'env-g6-phase1-chile');
  assert.equal(CHILE_POLICY.resource_group, 'rg-g6-aca-chile');
  assert.deepEqual(CHILE_POLICY.reviewer, {
    type: 'User',
    id: 143348512,
    login: 'mrcastilla8',
  });
  assert.equal(CHILE_POLICY.prevent_self_review, false);
  assert.equal(CHILE_POLICY.admin_bypass, false);
  assert.equal(CHILE_POLICY.allowed_branch, 'master');
});

test('accepts a complete synthetic same-run Chile receipt approved by Castilla', () => {
  const result = evaluateCdEvidence(evidence({ selfApproved: false }));
  assert.equal(result.execution_result, 'PASS');
  assert.equal(result.destination, 'chile-shared');
  assert.equal(result.environment, 'azure-h5-chile');
});

test('H08 accepts the Chile deploy.sh receipt without extra provenance or recovery fields', () => {
  const record = evidence();
  record.receipt = officialReceipt(record);

  assert.equal(evaluateCdEvidence(record).execution_result, 'PASS');
});

test('H08 validates the raw receipt against the run, smoke origin and digest', () => {
  checkFailure('CD-03', (record) => {
    record.receipt = { ...officialReceipt(record), workflow_run_id: '5678' };
  });
  checkFailure('CD-07', (record) => {
    record.receipt = {
      ...officialReceipt(record),
      origin_https: 'https://other.example',
    };
  });
  checkFailure('CD-03', (record) => {
    record.receipt = {
      ...officialReceipt(record),
      digest_candidate: 'sha256:' + 'e'.repeat(64),
    };
  });
  checkFailure('CD-03', (record) => {
    record.receipt = { ...officialReceipt(record), run_id: '5678' };
  });
});

test('H08 does not certify recovery using only the official receipt', () => {
  const record = evidence();
  record.receipt = officialReceipt(record);
  delete record.smoke;
  const result = evaluateCdEvidence(record);

  assert.equal(result.execution_result, 'FAIL');
  assert.equal(
    result.checks.find((entry) => entry.case_id === 'CD-08').execution_result,
    'FAIL',
  );
});

test('accepts a valid self-approval by Castilla under Chile policy', () => {
  const result = evaluateCdEvidence(evidence({ selfApproved: true }));
  assert.equal(result.execution_result, 'PASS');
  assert.equal(
    result.checks.find((entry) => entry.case_id === 'CD-04').execution_result,
    'PASS',
  );
});

test('rejects Brazil destination, Brazil environment and historical pilot environment', () => {
  checkFailure('CD-04', (record) => {
    record.destination = 'brazil-isolated';
    record.environment.destination = 'brazil-isolated';
    record.environment.name = 'azure-h5';
    record.oidc.federated_environment = 'azure-h5';
  });
  checkFailure('CD-03', (record) => {
    record.receipt.destination = 'brazil-isolated';
    record.receipt.github_environment = 'azure-h5';
    record.receipt.aca_environment = 'env-g6-h5-int';
  });
  checkFailure('CD-04', (record) => {
    record.environment.name = 'azure-h5-pilot-234';
    record.oidc.federated_environment = 'azure-h5-pilot-234';
  });
});

test('CD-01 rejects a different SHA', () =>
  checkFailure('CD-01', (record) => {
    record.master_sha = 'c'.repeat(40);
  }));

test('CD-02 rejects malformed, unverified, non-master and wrong repository SHA', () => {
  checkFailure('CD-02', (record) => {
    record.source_sha = 'abc';
  });
  checkFailure('CD-02', (record) => {
    record.head_verified = false;
  });
  checkFailure('CD-02', (record) => {
    record.repo = 'example/other';
  });
  checkFailure('CD-02', (record) => {
    record.ref = 'refs/heads/trabajo/cueva/h5-evidencia-local';
  });
});

test('CD-03 rejects wrong image, commit, ACA resource or served digest', () => {
  checkFailure('CD-03', (record) => {
    record.receipt.served_digest = 'sha256:' + 'c'.repeat(64);
  });
  checkFailure('CD-03', (record) => {
    record.image.source_sha = 'c'.repeat(40);
  });
  checkFailure('CD-03', (record) => {
    record.image.reference = record.image.reference.replace(
      'catalog-svc',
      'pricing-svc',
    );
  });
  checkFailure('CD-03', (record) => {
    record.receipt.app_resource_id = record.receipt.app_resource_id.replace(
      'rg-g6-aca-chile',
      'rg-g6-sb-h5-int-fork',
    );
  });
});

test('CD-04 rejects missing reviewer, different reviewer, extra reviewer, wrong approver, admin bypass or disallowed branch', () => {
  checkFailure('CD-04', (record) => {
    record.environment.reviewers = [];
  });
  checkFailure('CD-04', (record) => {
    record.environment.reviewers = [
      { type: 'User', id: 129343979, login: 'other-user' },
    ];
  });
  checkFailure('CD-04', (record) => {
    record.environment.reviewers = [
      castillaReviewer(),
      { type: 'User', id: 2, login: 'second-reviewer' },
    ];
  });
  checkFailure('CD-04', (record) => {
    record.environment.approved_by = {
      type: 'User',
      id: 999999,
      login: 'AXL031',
    };
  });
  checkFailure('CD-04', (record) => {
    record.environment.approval_run_id = '5678';
  });
  checkFailure('CD-04', (record) => {
    record.environment.admin_bypass = true;
  });
  checkFailure('CD-04', (record) => {
    record.environment.prevent_self_review = true;
  });
  checkFailure('CD-04', (record) => {
    record.environment.allowed_branches = ['master', 'release'];
  });
  checkFailure('CD-04', (record) => {
    record.environment.allowed_branches = ['develop'];
  });
  checkFailure('CD-04', (record) => {
    record.environment.branch_policy_type = 'tag';
  });
});

test('CD-05 rejects missing OIDC, wrong federated environment or persistent credentials', () => {
  checkFailure('CD-05', (record) => {
    delete record.oidc;
  });
  checkFailure('CD-05', (record) => {
    record.oidc.persistent_credentials = true;
  });
  checkFailure('CD-05', (record) => {
    record.oidc.federated_environment = 'azure-h5';
  });
});

test('CD-06 rejects missing, blocking and failed scan reports', () => {
  checkFailure('CD-06', (record) => {
    delete record.audit.report;
  });
  checkFailure('CD-06', (record) => {
    record.audit.report.metadata.vulnerabilities.high = 1;
  });
  checkFailure('CD-06', (record) => {
    record.audit.exit_code = 1;
  });
});

test('CD-07 rejects false positive 200 and never promotes after rollback', () => {
  checkFailure('CD-07', (record) => {
    record.smoke.liveness.body = { status: 'ok' };
  });
  checkFailure('CD-07', (record) => {
    record.smoke.readiness.body = {
      service: record.service,
      status: 'not_ready',
    };
  });
  checkFailure('CD-07', (record) => {
    record.smoke.readiness.http_status = 503;
    record.recovery = {
      run_id: record.run_id,
      service: record.service,
      source_sha: record.source_sha,
      supervised: true,
      candidate: record.image.reference,
      restored_image: record.receipt.previous_image,
      restored_revision: record.receipt.previous_revision,
    };
    assert.equal(
      evaluateCdEvidence(record).checks.find(
        (entry) => entry.case_id === 'CD-08',
      ).execution_result,
      'PASS',
    );
  });
});

test('CD-08 rejects rollback missing a previous revision or targeting another service', () => {
  checkFailure('CD-08', (record) => {
    delete record.smoke;
  });
  checkFailure('CD-08', (record) => {
    record.recovery = {
      run_id: record.run_id,
      service: 'another-service',
      source_sha: record.source_sha,
      supervised: true,
      candidate: record.image.reference,
      restored_image: record.receipt.previous_image,
      restored_revision: record.receipt.previous_revision,
    };
  });
});
