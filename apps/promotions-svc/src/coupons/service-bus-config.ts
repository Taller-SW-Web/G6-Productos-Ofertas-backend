export interface PromotionsServiceBusConfig {
  namespace: string;
  managedIdentityClientId?: string;
  eventsEnabled: boolean;
  couponCommandsEnabled?: boolean;
  couponAdmissionPaused?: boolean;
}

function isSecureG7Issuer(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      value?.trim() === value
    );
  } catch {
    return false;
  }
}

// Internal transport configuration, never a grant for the proposed G5 API.
export function readPromotionsServiceBus(
  env: Readonly<NodeJS.ProcessEnv>,
): PromotionsServiceBusConfig | undefined {
  const azure = env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';
  const flag = env.PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED;
  const couponCommands = env.PROMOTIONS_H5_COUPON_COMMANDS_ENABLED;
  const pauseAdmission = env.PROMOTIONS_H5_COUPON_ADMISSION_PAUSED;
  const production = env.G6_SERVICE_BUS_PRODUCTION_ENABLED;
  if (!azure) {
    if (
      (env.MESSAGING_PROVIDER !== undefined &&
        env.MESSAGING_PROVIDER !== 'RABBITMQ') ||
      (flag !== undefined && flag !== 'false') ||
      (couponCommands !== undefined && couponCommands !== 'false') ||
      (pauseAdmission !== undefined && pauseAdmission !== 'false') ||
      (production !== undefined && production !== 'false') ||
      env.SERVICE_BUS_NAMESPACE_FQDN !== undefined
    )
      throw new Error('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
    return undefined;
  }
  const identity = env.AZURE_CLIENT_ID;
  if (
    !['true', 'false'].includes(flag ?? 'false') ||
    !['true', 'false'].includes(couponCommands ?? 'false') ||
    !['true', 'false'].includes(pauseAdmission ?? 'false') ||
    (pauseAdmission === 'true' && couponCommands !== 'true') ||
    !['true', 'false'].includes(production ?? 'false') ||
    !['development', 'test', 'production'].includes(
      env.NODE_ENV ?? 'development',
    ) ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      env.SERVICE_BUS_NAMESPACE_FQDN ?? '',
    ) ||
    env.RABBITMQ_URL !== undefined ||
    env.PROMOTIONS_COUPON_RUNTIME_ENABLED === 'true' ||
    (couponCommands === 'true' &&
      (env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !isSecureG7Issuer(env.AUTH_ISSUER) ||
        !isSecureG7Issuer(env.AUTH_JWKS_URL) ||
        !identity)) ||
    (identity !== undefined &&
      (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity) ||
        /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(identity))) ||
    (env.NODE_ENV === 'production' &&
      (production !== 'true' ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        !identity)) ||
    (env.NODE_ENV !== 'production' && production === 'true')
  )
    throw new Error('PROMOTIONS_SERVICE_BUS_CONFIGURATION_INVALID');
  return Object.freeze({
    namespace: env.SERVICE_BUS_NAMESPACE_FQDN!,
    managedIdentityClientId: identity,
    eventsEnabled: flag === 'true',
    ...(couponCommands === 'true' ? { couponCommandsEnabled: true } : {}),
    ...(pauseAdmission === 'true' ? { couponAdmissionPaused: true } : {}),
  });
}
