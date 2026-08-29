import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import { BearerAuthGuard } from '../../common/auth.guard';
import { CurrentUser } from '../../common/current-user.decorator';
import { toHttpException } from '../../common/http-error';
import type { AuthenticatedPrincipal } from '../../auth.service';
import { UserError } from './user.errors';
import { UserService } from './user.service';
import type { User } from './user.types';

/**
 * GET /v1/users/me derives the target user exclusively from the authenticated
 * principal (see CurrentUser) - never from client-supplied input. A principal with no
 * matching row in the users store is a 404, not a fabricated response.
 */
@Controller('v1/users')
@UseGuards(BearerAuthGuard)
export class UserController {
  public constructor(
    @Inject(UserService)
    private readonly users: UserService,
  ) {}

  @Get('me')
  public async getCurrentUser(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<User> {
    try {
      return await this.users.getCurrentUser(principal.userId);
    } catch (error) {
      if (error instanceof UserError) {
        throw toHttpException(error);
      }
      throw error;
    }
  }
}
