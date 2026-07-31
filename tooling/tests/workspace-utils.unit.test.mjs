import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listWorkspaceDirectories } from '../scripts/workspace-utils.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('listWorkspaceDirectories', () => {
  it('discovers only direct app and service packages in stable order', async () => {
    const root = path.join(
      tmpdir(),
      `haitouwang-workspaces-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    temporaryDirectories.push(root);

    await Promise.all([
      mkdir(path.join(root, 'apps', 'web'), { recursive: true }),
      mkdir(path.join(root, 'apps', 'notes'), { recursive: true }),
      mkdir(path.join(root, 'services', 'api'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, 'apps', 'web', 'package.json'), '{}'),
      writeFile(path.join(root, 'services', 'api', 'package.json'), '{}'),
    ]);

    const workspaces = await listWorkspaceDirectories(root);

    expect(workspaces.map((directory) => path.relative(root, directory))).toEqual([
      path.join('apps', 'web'),
      path.join('services', 'api'),
    ]);
  });
});
