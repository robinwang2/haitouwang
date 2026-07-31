import { readdir } from 'node:fs/promises';
import path from 'node:path';

async function directPackages(parentDirectory) {
  let entries;

  try {
    entries = await readdir(parentDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDirectory, entry.name))
    .sort();

  const packages = [];
  for (const candidate of candidates) {
    const files = await readdir(candidate);
    if (files.includes('package.json')) {
      packages.push(candidate);
    }
  }

  return packages;
}

export async function listWorkspaceDirectories(repositoryRoot) {
  const groups = await Promise.all([
    directPackages(path.join(repositoryRoot, 'apps')),
    directPackages(path.join(repositoryRoot, 'services')),
  ]);

  return groups.flat().sort();
}
