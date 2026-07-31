import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { listWorkspaceDirectories } from './workspace-utils.mjs';

const toolingDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(toolingDirectory, '..');
const typescriptCli = path.join(toolingDirectory, 'node_modules', 'typescript', 'bin', 'tsc');
const workspaces = await listWorkspaceDirectories(repositoryRoot);

for (const workspace of workspaces) {
  const config = path.join(workspace, 'tsconfig.json');
  try {
    await access(config);
  } catch {
    continue;
  }

  const label = path.relative(repositoryRoot, workspace).replaceAll(path.sep, '/');
  console.info(`typecheck: ${label}`);
  const result = spawnSync(process.execPath, [typescriptCli, '--project', config, '--noEmit'], {
    cwd: toolingDirectory,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
