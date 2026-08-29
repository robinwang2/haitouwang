import { Inject, Injectable } from '@nestjs/common';

import { USER_STORE } from './user-store.interface';
import type { UserStore } from './user-store.interface';
import { UserError } from './user.errors';
import type { User } from './user.types';

@Injectable()
export class UserService {
  constructor(
    @Inject(USER_STORE)
    private readonly store: UserStore,
  ) {}

  async getCurrentUser(userId: string): Promise<User> {
    const user = await this.store.getUser(userId);
    if (!user) {
      throw new UserError('RESOURCE_NOT_FOUND', 'User was not found.', 404);
    }
    return user;
  }
}
