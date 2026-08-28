import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { AuthError, AuthService } from '../auth.service';
import type { AuthenticatedPrincipal } from '../auth.service';
import { httpError } from './http-error';

export interface AuthenticatedRequest {
  headers: { authorization?: string };
  principal?: AuthenticatedPrincipal;
}

/**
 * Verifies the OpenAPI `UserBearer` JWT on every guarded route and attaches the
 * derived principal to the request. Handlers must read tenant identity from the
 * attached principal (see CurrentUser), never from client-supplied body/query data.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  public constructor(
    @Inject(AuthService)
    private readonly auth: AuthService,
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    try {
      request.principal = this.auth.authenticate(request.headers.authorization);
      return true;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // FORBIDDEN means the token is well-formed but its claims are not accepted
      // (e.g. wrong audience) - distinct from "no/invalid credentials" (401).
      throw httpError(error.code === 'FORBIDDEN' ? 403 : 401, error.code, error.message);
    }
  }
}
