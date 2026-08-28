import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from './auth.guard';
import type { AuthenticatedPrincipal } from '../auth.service';

/**
 * Tenant context: resolves the authenticated principal that BearerAuthGuard attached
 * to the request. Routes must use this instead of reading user_id from @Body()/@Query() -
 * the contract states tenancy is derived from the authenticated principal, not client input.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal) {
      throw new Error('CurrentUser used on a route without BearerAuthGuard.');
    }
    return request.principal;
  },
);
