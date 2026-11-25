import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCdEvidence } from './verify-release-evidence.mjs';

function evidence() {
  const sha = 'a'.repeat(40);
  const digest = 'sha256:' + 'b'.repeat(64);
  const service = 'catalog-svc';
  const origin = 'https://catalog.test.invalid';
  const prefix =
    'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/' + service + '@';
  return {
    repo: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    ref: 'refs/heads/master',
    source_sha: sha,
    master_sha: sha,
    head_verified: true,
    service,
    run_id: '12345',
    image: { source_sha: sha, reference: prefix + digest },
    receipt: {
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
      name: 'azure-h5',
      approval_verified: true,
      approval_run_id: '12345',
      reviewers: 2,
      prevent_self_review: true,
      admin_bypass: false,
      allowed_branches: ['master'],
    },
    oidc: {
      method: 'oidc',
      run_id: '12345',
      persistent_credentials: false,
      federated_environment: 'azure-h5',
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

test('accepts a complete synthetic same-run receipt', () => {
  assert.equal(evaluateCdEvidence(evidence()).execution_result, 'PASS');
});

test('CD-01 rejects a different SHA', () =>
  checkFailure('CD-01', (record) => {
    record.master_sha = 'c'.repeat(40);
  }));

test('CD-02 rejects malformed, unverified and wrong repository SHA', () => {
  checkFailure('CD-02', (record) => {
    record.source_sha = 'abc';
  });
  checkFailure('CD-02', (record) => {
    record.head_verified = false;
  });
  checkFailure('CD-02', (record) => {
    record.repo = 'example/other';
  });
});

test('CD-03 rejects wrong image, commit or served digest', () => {
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
});

test('CD-04 rejects missing reviewers or wrong run', () => {
  checkFailure('CD-04', (record) => {
    record.environment.reviewers = 0;
  });
  checkFailure('CD-04', (record) => {
    record.environment.approval_run_id = '5678';
  });
  checkFailure('CD-04', (record) => {
    record.environment.admin_bypass = true;
  });
});

test('CD-05 rejects missing OIDC or persistent credentials', () => {
  checkFailure('CD-05', (record) => {
    delete record.oidc;
  });
  checkFailure('CD-05', (record) => {
    record.oidc.persistent_credentials = true;
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
