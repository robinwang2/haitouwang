import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { listWorkspaceDirectories } from './workspace-utils.mjs';

const operation = process.argv[2];
if (!['ci', 'audit'].includes(operation)) {
  console.error('Usage: node scripts/npm-workspaces.mjs <ci|audit>');
  process.exit(2);
}

const toolingDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(toolingDirectory, '..');
const workspaces = await listWorkspaceDirectories(repositoryRoot);
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error('Run this script through npm so npm_execpath is available.');
  process.exit(2);
}

const targets = operation === 'audit' ? [toolingDirectory, ...workspaces] : workspaces;
for (const target of targets) {
  const label = path.relative(repositoryRoot, target).replaceAll(path.sep, '/');
  const args =
    operation === 'ci'
      ? [npmCli, 'ci', '--ignore-scripts']
      : [npmCli, 'audit', '--audit-level=high'];

  console.info(`${operation}: ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: target,
    env: {
      ...process.env,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
