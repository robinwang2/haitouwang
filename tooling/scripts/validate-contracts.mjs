import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const toolingDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(toolingDirectory, '..');
const contractsDirectory = path.join(repositoryRoot, 'contracts');

async function readJson(relativePath) {
  const contents = await readFile(path.join(contractsDirectory, relativePath), 'utf8');
  return JSON.parse(contents);
}

function assertValid(validate, data, label) {
  if (!validate(data)) {
    console.error(`${label} failed contract validation:`);
    console.error(JSON.stringify(validate.errors, null, 2));
    process.exit(1);
  }
  console.info(`valid: ${label}`);
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(ajv);

const domainSchema = await readJson('schemas/domain.schema.json');
const eventSchema = await readJson('events/event.schema.json');
const validateDomain = ajv.compile(domainSchema);
const validateEvent = ajv.compile(eventSchema);

assertValid(
  validateDomain,
  await readJson('examples/domain-smoke.json'),
  'examples/domain-smoke.json',
);

const exampleFiles = (await readdir(path.join(contractsDirectory, 'examples')))
  .filter((fileName) => fileName.endsWith('.event.json'))
  .sort();

for (const fileName of exampleFiles) {
  assertValid(
    validateEvent,
    await readJson(path.join('examples', fileName)),
    `examples/${fileName}`,
  );
}
