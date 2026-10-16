export function readHttpConfig(env: Readonly<NodeJS.ProcessEnv>) {
  const raw = env.CATALOG_SVC_PORT ?? env.PORT ?? '3001';
  const port = Number(raw);
  const host = env.CATALOG_SVC_HOST ?? '127.0.0.1';
  if (
    !/^\d+$/.test(raw) ||
    port < 1 ||
    port > 65535 ||
    !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(host)
  )
    throw new Error('Configuración HTTP catalog inválida');
  return { port, host };
}
