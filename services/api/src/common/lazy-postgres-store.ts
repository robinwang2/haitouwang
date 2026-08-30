import { Pool } from 'pg';

/**
 * Reads DATABASE_URL and throws a module-specific error if it is unset. Shared so every
 * store module reports the same information: which module needed it, and that this module
 * will not silently fall back to an in-memory store.
 */
export function resolveDatabaseUrl(moduleName: string): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      `DATABASE_URL is not set. ${moduleName} requires PostgreSQL as the single source of truth ` +
        'and will not silently fall back to an in-memory store. Set DATABASE_URL to use this store.',
    );
  }
  return connectionString;
}

type AsyncMethod = (...args: never[]) => unknown;

/**
 * One entry per TStore method, each set to `true`. Passing this as an object literal (rather
 * than a plain string array) makes TypeScript's excess/missing-property checks enforce that
 * the method list stays exhaustive - add a method to the store interface and this type stops
 * compiling until the call site lists it too.
 */
type MethodFlags<TStore> = { readonly [K in keyof TStore]-?: true };

/**
 * Builds a store satisfying TStore that never touches DATABASE_URL or opens a Pool at
 * construction time. Each listed method resolves the connection - and builds the real
 * Postgres-backed store - on first call only, throwing if DATABASE_URL is still unset at
 * that point. This lets a module be imported (and NestFactory.create()'d) with no database
 * configured; only an actual attempt to read/write through the store fails.
 */
export function createLazyPostgresStore<TStore extends object>(
  moduleName: string,
  methodFlags: MethodFlags<TStore>,
  buildStore: (pool: Pool) => TStore,
): TStore {
  let real: TStore | undefined;

  function resolveStore(): TStore {
    if (!real) {
      real = buildStore(new Pool({ connectionString: resolveDatabaseUrl(moduleName) }));
    }
    return real;
  }

  const lazyStore = {} as Record<keyof TStore, AsyncMethod>;
  for (const methodName of Object.keys(methodFlags) as (keyof TStore)[]) {
    lazyStore[methodName] = (...args: never[]) =>
      (resolveStore()[methodName] as AsyncMethod)(...args);
  }
  return lazyStore as TStore;
}
