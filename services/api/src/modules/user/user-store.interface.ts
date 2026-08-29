import type { User } from './user.types';

export const USER_STORE = Symbol('USER_STORE');

/**
 * Persistence boundary for the users aggregate. GET /v1/users/me is the only consumer
 * today, so the boundary is deliberately narrow - a single tenant-scoped lookup by id.
 */
export interface UserStore {
  getUser(userId: string): Promise<User | undefined>;
}
