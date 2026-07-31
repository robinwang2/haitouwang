import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalApplicationRunner } from '../src/application-runner.js';
import { PlaywrightApplicationPage } from '../src/playwright-page.js';
import type { ConfirmationGrant, ConfirmationVerifier } from '../src/types.js';

const RESUME_PATH = fileURLToPath(new URL('./fixtures/resume.pdf', import.meta.url));

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

const verifier: ConfirmationVerifier = {
  verify(_grant: ConfirmationGrant) {
    return true;
  },
  consume(_grant: ConfirmationGrant) {
    return true;
  },
};

describe('PlaywrightApplicationPage fixed browser fixtures', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it.each([
    {
      fixtureName: 'greenhouse.html',
      platform: 'greenhouse' as const,
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      expectedName: 'Ada',
      nameSelector: '#first_name',
    },
    {
      fixtureName: 'lever.html',
      platform: 'lever' as const,
      answers: {
        full_name: 'Grace Hopper',
        email: 'grace@example.test',
        phone: '+1 555 0101',
        linkedin_url: 'https://www.linkedin.com/in/example',
      },
      expectedName: 'Grace Hopper',
      nameSelector: '#name',
    },
  ])('fills and uploads the $platform fixture in Chromium', async (testCase) => {
    await page.setContent(fixture(testCase.fixtureName));
    const runner = new LocalApplicationRunner(new PlaywrightApplicationPage(page), verifier);

    const outcome = await runner.fill({
      answers: testCase.answers,
      materials: { resume: RESUME_PATH },
    });

    expect(outcome).toMatchObject({
      state: 'awaiting_confirmation',
      status: 'paused',
      preview: { platform: testCase.platform, uploadedMaterials: ['resume'] },
    });
    expect(await page.locator(testCase.nameSelector).inputValue()).toBe(testCase.expectedName);
    expect(
      await page.locator('#resume').evaluate((input: HTMLInputElement) => input.files?.length),
    ).toBe(1);
  });
});
