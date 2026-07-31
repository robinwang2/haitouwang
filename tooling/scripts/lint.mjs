import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolingDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(toolingDirectory, '..');
const eslintCli = path.join(toolingDirectory, 'node_modules', 'eslint', 'bin', 'eslint.js');
const result = spawnSync(
  process.execPath,
  [
    eslintCli,
    '--config',
    path.join(toolingDirectory, 'eslint.config.mjs'),
    '--max-warnings',
    '0',
    'tooling',
    'apps',
    'services',
  ],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
