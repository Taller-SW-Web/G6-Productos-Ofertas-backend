import { SetMetadata } from '@nestjs/common';
import { REQUIRED_SCOPE_KEY, ALLOWED_CLIENTS_KEY } from './auth.constants.js';

export const RequireScope = (scope: string) =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope);

export const AllowedClients = (clients: string[]) =>
  SetMetadata(ALLOWED_CLIENTS_KEY, clients);
