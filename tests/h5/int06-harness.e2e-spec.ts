import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('INT-06 harness prerequisites', () => {
  it('reports BLOCKED_SB rather than a successful Azure test', () => {
    const p = spawnSync(process.execPath, ['tests/h5/run-int06.mjs', 'azure'], {
      encoding: 'utf8',
    });
    expect(p.status).toBe(2);
    expect(JSON.parse(p.stdout).cases[0]).toMatchObject({
      execution_result: 'BLOCKED_SB',
      level: 'L2_PENDING',
    });
  });
  it('reports BLOCKED_CONTRACT if the official Docs files are missing', () => {
    const p = spawnSync(
      process.execPath,
      ['tests/h5/run-int06.mjs', 'contract'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          G6_E2E_DOCS_PATH: resolve('tests/h5/missing-docs-fixture'),
        },
      },
    );
    expect(p.status).toBe(2);
    expect(JSON.parse(p.stdout).cases[0]).toMatchObject({
      execution_result: 'BLOCKED_CONTRACT',
    });
  });
});
