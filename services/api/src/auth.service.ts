import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

export interface AuthenticatedPrincipal {
  userId: string;
  permissions: string[];
}

@Injectable()
export class AuthService {
  private readonly tokens = new Map<string, AuthenticatedPrincipal>();

  public registerPrincipal(principal: AuthenticatedPrincipal): string {
    const token = randomUUID();
    this.tokens.set(token, structuredClone(principal));
    return token;
  }

  public authenticate(authorization: string | undefined): AuthenticatedPrincipal | undefined {
    const match = /^Bearer ([A-Za-z0-9-]+)$/u.exec(authorization ?? '');
    const principal = match ? this.tokens.get(match[1]!) : undefined;
    return principal ? structuredClone(principal) : undefined;
  }
}
