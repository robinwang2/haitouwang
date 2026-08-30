import { Module } from '@nestjs/common';

import { AuthService } from '../../auth.service';
import { createLazyPostgresStore } from '../../common/lazy-postgres-store';
import { USER_STORE } from './user-store.interface';
import type { UserStore } from './user-store.interface';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { PostgresUserStore } from './user.postgres-store';

function createUserStore(): UserStore {
  return createLazyPostgresStore<UserStore>(
    'UserModule',
    {
      getUser: true,
    },
    (pool) => new PostgresUserStore(pool),
  );
}

@Module({
  controllers: [UserController],
  providers: [
    { provide: USER_STORE, useFactory: createUserStore },
    UserService,
    // BearerAuthGuard (used by UserController) depends on AuthService. AppModule also
    // provides AuthService, but Nest module DI is not ambient across sibling imports, so
    // this module needs its own instance; AuthService is stateless (reads env at
    // construction only), so a second instance is safe.
    AuthService,
  ],
  exports: [UserService],
})
export class UserModule {}
