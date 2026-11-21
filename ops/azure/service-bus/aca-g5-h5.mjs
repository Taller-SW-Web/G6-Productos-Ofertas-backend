const services = ['inventory-svc', 'promotions-svc'];
const managedResource =
  /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-z0-9_.()-]+\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/[a-z0-9_-]+$/i;
const nonzeroUuid =
  /^(?!0{8}-0{4}-0{4}-0{4}-0{12}$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const bool = (value) => value === 'true' || value === 'false';
const fail = () => {
  throw new Error('G5_H5_ACA_CONFIGURATION_INVALID');
};

export function validateG5H5Aca(runtime, plan) {
  const azureServices = Object.entries(runtime)
    .filter(
      ([, env]) =>
        env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS' ||
        env.G6_SERVICE_BUS_PRODUCTION_ENABLED === 'true' ||
        env.G6_SERVICE_BUS_PILOT_ENABLED === 'true',
    )
    .map(([name]) => name)
    .sort();
  if (
    !plan ||
    Object.keys(plan).sort().join() !== 'identities,namespace' ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/.test(
      plan.namespace ?? '',
    ) ||
    Object.keys(plan.identities ?? {})
      .sort()
      .join() !== services.join() ||
    azureServices.join() !== services.join()
  )
    fail();

  for (const service of services) {
    const identity = plan.identities[service];
    const env = runtime[service];
    if (
      !identity ||
      Object.keys(identity).sort().join() !== 'clientId,resourceId' ||
      !managedResource.test(identity.resourceId ?? '') ||
      !nonzeroUuid.test(identity.clientId ?? '') ||
      env.NODE_ENV !== 'production' ||
      env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
      env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS' ||
      env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true' ||
      env.SERVICE_BUS_NAMESPACE_FQDN !== plan.namespace ||
      env.AZURE_CLIENT_ID?.toLowerCase() !== identity.clientId.toLowerCase() ||
      env.RABBITMQ_URL !== undefined
    )
      fail();
  }
  const [inventoryIdentity, promotionsIdentity] = services.map(
    (service) => plan.identities[service],
  );
  if (
    inventoryIdentity.clientId.toLowerCase() ===
      promotionsIdentity.clientId.toLowerCase() ||
    inventoryIdentity.resourceId.toLowerCase() ===
      promotionsIdentity.resourceId.toLowerCase()
  )
    fail();
  const inventory = runtime['inventory-svc'];
  const promotions = runtime['promotions-svc'];
  if (
    inventory.G6_SERVICE_BUS_PILOT_ENABLED !== 'true' ||
    !bool(inventory.INVENTORY_SERVICE_BUS_PUBLISH_ENABLED) ||
    !bool(inventory.INVENTORY_SERVICE_BUS_CONSUME_ENABLED) ||
    promotions.G6_SERVICE_BUS_PILOT_ENABLED === 'true' ||
    promotions.PROMOTIONS_COUPON_RUNTIME_ENABLED === 'true' ||
    !bool(promotions.PROMOTIONS_H5_COUPON_COMMANDS_ENABLED) ||
    !bool(promotions.PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED) ||
    (runtime['api-gateway'].GATEWAY_G5_H5_ENABLED === 'true' &&
      (promotions.PROMOTIONS_H5_COUPON_COMMANDS_ENABLED !== 'true' ||
        !promotions.PROMOTIONS_H5_SERVICE_CLIENT_SECRET?.trim() ||
        promotions.PROMOTIONS_H5_SERVICE_CLIENT_SECRET ===
          promotions.PROMOTIONS_SERVICE_CLIENT_SECRET))
  )
    fail();

  return Object.fromEntries(
    services.map((service) => [
      service,
      {
        type: 'UserAssigned',
        userAssignedIdentities: { [plan.identities[service].resourceId]: {} },
      },
    ]),
  );
}
