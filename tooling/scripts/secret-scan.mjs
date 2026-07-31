import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolingDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(toolingDirectory, '..');
const ignoredDirectories = new Set(['.next', 'coverage', 'dist', 'node_modules']);
const ignoredFiles = new Set(['package-lock.json']);
const supportedExtensions = new Set([
  '.example',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(target)));
    } else if (
      entry.isFile() &&
      !ignoredFiles.has(entry.name) &&
      supportedExtensions.has(path.extname(entry.name))
    ) {
      files.push(target);
    }
  }

  return files;
}

const scanRoots = [
  path.join(repositoryRoot, '.github'),
  path.join(repositoryRoot, 'apps'),
  path.join(repositoryRoot, 'infra', 'dev'),
  path.join(repositoryRoot, 'services'),
  toolingDirectory,
];
const files = (await Promise.all(scanRoots.map(collectFiles))).flat().sort();
const secretlintCli = path.join(
  toolingDirectory,
  'node_modules',
  'secretlint',
  'bin',
  'secretlint.js',
);
const result = spawnSync(
  process.execPath,
  [secretlintCli, '--secretlintrc', path.join(toolingDirectory, '.secretlintrc.json'), ...files],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
