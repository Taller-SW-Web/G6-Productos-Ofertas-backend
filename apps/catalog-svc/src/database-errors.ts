import { ServiceUnavailableException } from '@nestjs/common';

export type CatalogPersistenceFailure =
  | 'connection'
  | 'unique'
  | 'foreign_key'
  | 'check'
  | 'serialization'
  | 'deadlock'
  | 'deferred_constraint'
  | 'other';

type PostgresFailure = Error & {
  code?: unknown;
  constraint?: unknown;
};

export class CatalogPersistenceError extends ServiceUnavailableException {
  readonly failure: CatalogPersistenceFailure;
  readonly sqlState?: string;
  readonly constraintName?: string;

  constructor(
    failure: CatalogPersistenceFailure,
    sqlState?: string,
    constraintName?: string,
  ) {
    super('Servicio temporalmente no disponible');
    this.name = 'CatalogPersistenceError';
    this.failure = failure;
    this.sqlState = sqlState;
    this.constraintName = constraintName;
  }
}

function isPostgresFailure(value: unknown): value is PostgresFailure {
  return value instanceof Error && 'code' in value;
}

export function translatePostgresFailure(
  value: unknown,
  commitPhase = false,
): CatalogPersistenceError {
  if (value instanceof CatalogPersistenceError) return value;
  const code = isPostgresFailure(value) ? value.code : undefined;
  const driverCode = typeof code === 'string' ? code : undefined;
  const sqlState =
    driverCode && /^[0-9A-Z]{5}$/.test(driverCode) ? driverCode : undefined;
  const constraint = isPostgresFailure(value) ? value.constraint : undefined;
  const constraintName =
    typeof constraint === 'string' ? constraint : undefined;

  let failure: CatalogPersistenceFailure;
  if (
    driverCode?.startsWith('08') ||
    driverCode?.startsWith('53') ||
    driverCode?.startsWith('57') ||
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENOTFOUND',
      'ETIMEDOUT',
    ].includes(driverCode ?? '') ||
    driverCode?.startsWith('ERR_TLS_')
  ) {
    failure = 'connection';
  } else if (
    commitPhase &&
    ['23503', '23505', '23514'].includes(sqlState ?? '')
  ) {
    failure = 'deferred_constraint';
  } else {
    switch (driverCode) {
      case '23505':
        failure = 'unique';
        break;
      case '23503':
        failure = 'foreign_key';
        break;
      case '23514':
        failure = 'check';
        break;
      case '40001':
        failure = 'serialization';
        break;
      case '40P01':
        failure = 'deadlock';
        break;
      default:
        failure = 'other';
    }
  }

  return new CatalogPersistenceError(failure, sqlState, constraintName);
}
