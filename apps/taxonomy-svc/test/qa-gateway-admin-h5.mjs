import { pathToFileURL } from 'node:url';

export function checkConfig(env) {
  const required = [
    'G6_TAXONOMY_QA_GATEWAY_ORIGIN',
    'G6_TAXONOMY_QA_EXPECTED_SHA',
    'JWS_GESTOR_COMERCIAL',
    'JWS_SIN_PERMISOS',
  ];
  const missing = required.filter((name) => !env[name]);
  const errors = [];
  if (env.G6_TAXONOMY_QA_GATEWAY_ORIGIN) {
    try {
      const url = new URL(env.G6_TAXONOMY_QA_GATEWAY_ORIGIN);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error();
    } catch {
      errors.push('G6_TAXONOMY_QA_GATEWAY_ORIGIN_INVALID');
    }
  }
  if (
    env.G6_TAXONOMY_QA_EXPECTED_SHA &&
    !/^[0-9a-f]{40}$/i.test(env.G6_TAXONOMY_QA_EXPECTED_SHA)
  )
    errors.push('G6_TAXONOMY_QA_EXPECTED_SHA_INVALID');
  for (const name of ['JWS_GESTOR_COMERCIAL', 'JWS_SIN_PERMISOS']) {
    if (
      env[name] &&
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(env[name])
    )
      errors.push(`${name}_INVALID`);
  }
  if (
    env.JWS_GESTOR_COMERCIAL &&
    env.JWS_GESTOR_COMERCIAL === env.JWS_SIN_PERMISOS
  )
    errors.push('IDENTIDADES_IGUALES');
  return { missing, errors };
}

export async function runChecks(env, fetcher = fetch) {
  const { missing, errors } = checkConfig(env);
  if (missing.length || errors.length) throw new Error('CONFIG_INVALID');
  const origin = new URL(env.G6_TAXONOMY_QA_GATEWAY_ORIGIN).origin;
  const cases = [
    ['health', '/health', null, 200],
    ['gestor', '/api/v1/categorias/administracion', env.JWS_GESTOR_COMERCIAL, 200],
    ['sin_permisos', '/api/v1/categorias/administracion', env.JWS_SIN_PERMISOS, 403],
  ];
  const results = [];
  for (const [name, path, token, expected] of cases) {
    let response;
    try {
      response = await fetcher(origin + path, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`${name}: NETWORK_ERROR`);
    }
    results.push({ case: name, status: response.status, expected, pass: response.status === expected });
  }
  return { results, expected_sha: env.G6_TAXONOMY_QA_EXPECTED_SHA, deployed_sha: 'NOT_VERIFIED' };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3 || !['--check', '--run'].includes(process.argv[2])) {
    console.error('Uso: --check | --run');
    process.exitCode = 2;
  } else if (process.argv[2] === '--check') {
    const { missing, errors } = checkConfig(process.env);
    console.log(
      JSON.stringify({
        mode: 'CHECK_ONLY',
        missing,
        errors,
        remote_execution: 'NOT_RUN',
        deployed_sha: 'NOT_VERIFIED',
      }),
    );
    if (errors.length) process.exitCode = 1;
  } else {
    try {
      const report = await runChecks(process.env);
      console.log(JSON.stringify(report));
      if (report.results.some((result) => !result.pass)) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
