import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
// Usa el cliente compilado real y un ID inexistente, sin fabricar datos maestros.
process.env.CATALOG_TAXONOMY_URL = process.argv[2];
const moduleUrl = new URL('./taxonomy.client.js', pathToFileURL(process.argv[3]));
const { TaxonomyClient } = await import(moduleUrl.href);
await assert.rejects(new TaxonomyClient().category(randomUUID(), randomUUID()), error => error.getStatus() === 422);
await assert.rejects(new TaxonomyClient().brand(randomUUID(), randomUUID()), error => error.getStatus() === 422);
console.log('PASS: cliente Catalog -> Taxonomy real por HTTP (solo lectura)');
