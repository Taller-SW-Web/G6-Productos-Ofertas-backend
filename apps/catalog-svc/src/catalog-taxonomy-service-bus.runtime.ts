/**
 * Compatibility export for callers that referenced the former R18/R09-only runtime.
 * AppModule registers the single CatalogServiceBusRuntime for all four H5 receivers.
 */
export { CatalogServiceBusRuntime as CatalogTaxonomyServiceBusRuntime } from './catalog-service-bus.runtime.js';
