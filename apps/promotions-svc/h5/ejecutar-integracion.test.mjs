import assert from 'node:assert/strict';
import test from 'node:test';
import { cancellationSteps, executeCancellation } from './ejecutar-integracion.mjs';

test('G5-H5-04 configura solo liberación y G5-H5-06 conserva restauración comercial', async () => {
  assert.deepEqual(cancellationSteps({ cancel_mode: 'release-only' }), ['release']);
  assert.deepEqual(cancellationSteps({ cancel_mode: 'restore-consumption' }), ['restore', 'release']);
  assert.throws(() => cancellationSteps({ cancel_mode: undefined }), /CANCEL_MODE_REQUIRED/);
  const calls = [];
  await executeCancellation({
    case_id: 'G5-H5-04', cancel_mode: 'release-only', order_id: 'SYNTHETIC-ORDER',
  }, { occurred_at: '2026-11-22T16:00:00Z' }, async (...args) => {
    calls.push(args);
    return { status: 'COMPLETED' };
  }, (name) => {
    assert.equal(name, 'release');
    return 'release-operation-id';
  }, () => '/inventario/reservas/reservation-id');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'inventario');
  assert.equal(calls[0][1], '/inventario/reservas/reservation-id/liberar');
  assert.ok(!calls.some(([, path]) => path === '/cupones/restauraciones'));
});
