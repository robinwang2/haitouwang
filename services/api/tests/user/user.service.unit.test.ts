import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InMemoryUserStore, UserError, UserService } from '../../src/modules/user';
import type { User } from '../../src/modules/user';

function userFixture(overrides: Partial<User> = {}): User {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    email: 'candidate@example.com',
    display_name: 'Candidate Zero',
    locale: 'en-US',
    time_zone: 'America/New_York',
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('UserService', () => {
  it('returns the user matching the authenticated principal', async () => {
    const store = new InMemoryUserStore();
    const user = userFixture();
    store.users.set(user.id, user);
    const service = new UserService(store);

    await expect(service.getCurrentUser(user.id)).resolves.toEqual(user);
  });

  it('throws a 404 RESOURCE_NOT_FOUND UserError when the principal has no stored user', async () => {
    const store = new InMemoryUserStore();
    const service = new UserService(store);
    const missingUserId = randomUUID();

    await expect(service.getCurrentUser(missingUserId)).rejects.toMatchObject(
      new UserError('RESOURCE_NOT_FOUND', 'User was not found.', 404),
    );
  });

  it('does not fabricate a user from the principal id when the store is empty', async () => {
    const store = new InMemoryUserStore();
    const service = new UserService(store);
    const userId = randomUUID();

    let caught: unknown;
    try {
      await service.getCurrentUser(userId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UserError);
    expect((caught as UserError).code).toBe('RESOURCE_NOT_FOUND');
  });
});
