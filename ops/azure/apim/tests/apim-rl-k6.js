// Script k6 parametrizado para RL-01..RL-06 y APIM-T05 (sin ejecución automática).
// Uso autorizado: k6 run -e APIM_BASE_URL=https://<host>/api/v1 -e APIM_RL_AUTHORIZED=1 ops/azure/apim/tests/apim-rl-k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';

if (__ENV.APIM_RL_AUTHORIZED !== '1' || !__ENV.APIM_BASE_URL) {
  throw new Error('APIM_RL_AUTHORIZED=1 y APIM_BASE_URL son obligatorios');
}

export const options = {
  scenarios: {
    rl_burst_client_a: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 10,
      exec: 'burstClientA',
    },
    rl_isolated_client_b: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 4,
      exec: 'isolatedClientB',
    },
  },
};

const baseUrl = __ENV.APIM_BASE_URL;
const tokenA = __ENV.APIM_JWT_CLIENT_A || '';
const tokenB = __ENV.APIM_JWT_CLIENT_B || '';

export function burstClientA() {
  const res = http.get(`${baseUrl}/productos`, {
    headers: tokenA ? { Authorization: `Bearer ${tokenA}` } : {},
  });
  check(res, {
    'RL-01/RL-02 status 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}

export function isolatedClientB() {
  const res = http.get(`${baseUrl}/productos`, {
    headers: tokenB ? { Authorization: `Bearer ${tokenB}` } : {},
  });
  check(res, {
    'RL-06 client B isolated (200)': (r) => r.status === 200,
  });
  sleep(0.2);
}
