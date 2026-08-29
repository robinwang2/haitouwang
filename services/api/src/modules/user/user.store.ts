import { Injectable } from '@nestjs/common';

import type { UserStore } from './user-store.interface';
import type { User } from './user.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

@Injectable()
export class InMemoryUserStore implements UserStore {
  readonly users = new Map<string, User>();

  async getUser(userId: string): Promise<User | undefined> {
    const user = this.users.get(userId);
    return user ? clone(user) : undefined;
  }
}
