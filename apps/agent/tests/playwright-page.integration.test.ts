import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalApplicationRunner } from '../src/application-runner.js';
import { PlaywrightApplicationPage } from '../src/playwright-page.js';
import type { ConfirmationGrant, ConfirmationVerifier } from '../src/types.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const RESUME_PATH = fileURLToPath(new URL('./fixtures/resume.pdf', import.meta.url));

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

class OneTimeVerifier implements ConfirmationVerifier {
  private consumed = false;

  verify(_grant: ConfirmationGrant): boolean {
    return !this.consumed;
  }

  consume(grant: ConfirmationGrant): boolean {
    if (!this.verify(grant)) return false;
    this.consumed = true;
    return true;
  }
}

function grant(previewHash: string): ConfirmationGrant {
  return {
    token: 'browser-fixture-confirmation',
    applicationId: 'application-1',
    commandId: 'command-1',
    previewHash,
    expiresAt: '2026-07-31T12:02:00.000Z',
  };
}

function submitCount(): Promise<number> {
  return page.evaluate(() => {
    const fixtureWindow = window as typeof window & { fixtureSubmitCount?: number };
    return fixtureWindow.fixtureSubmitCount ?? 0;
  });
}

async function trackSubmissions(): Promise<void> {
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & { fixtureSubmitCount: number };
    fixtureWindow.fixtureSubmitCount = 0;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      fixtureWindow.fixtureSubmitCount += 1;
    });
  });
}

let page: Page;

async function launchFixtureBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (chromiumError) {
    if (
      !(chromiumError instanceof Error) ||
      !chromiumError.message.includes("Executable doesn't exist")
    ) {
      throw chromiumError;
    }
    try {
      return await chromium.launch({ channel: 'msedge', headless: true });
    } catch (edgeError) {
      throw new Error(
        'Neither Playwright Chromium nor the local Edge Chromium browser could be launched.',
        { cause: edgeError },
      );
    }
  }
}

describe('PlaywrightApplicationPage fixed browser fixtures', () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await launchFixtureBrowser();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  function runner(verifier: ConfirmationVerifier = new OneTimeVerifier()) {
    return new LocalApplicationRunner(
      new PlaywrightApplicationPage(page, { submissionTimeoutMs: 100 }),
      verifier,
      () => NOW,
    );
  }

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
    const applicationRunner = runner();

    const outcome = await applicationRunner.fill({
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

  it.each([
    {
      fixtureName: 'captcha.html',
      manualReason: 'captcha',
      recoveryAction: 'user_complete_locally',
    },
    {
      fixtureName: 'unknown-question.html',
      manualReason: 'unknown_required_field',
      recoveryAction: 'user_answer_required',
    },
  ] as const)('safely stops for $manualReason without changing the page', async (testCase) => {
    await page.setContent(fixture(testCase.fixtureName));

    await expect(
      runner().fill({ answers: { email: 'user@example.test' }, materials: {} }),
    ).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: testCase.manualReason,
      recoveryAction: testCase.recoveryAction,
    });
    expect(await page.locator('#email').inputValue()).toBe('');
  });

  it('invalidates a confirmed preview after a non-empty browser field is changed', async () => {
    await page.setContent(fixture('greenhouse.html'));
    await trackSubmissions();
    const applicationRunner = runner();
    const fill = await applicationRunner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'approved@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');
    await page.locator('#email').fill('altered@example.test');

    await expect(
      applicationRunner.submit(fill.preview, grant(fill.preview.hash)),
    ).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'page_structure_changed',
    });
    expect(await submitCount()).toBe(0);
  });

  it('clicks once, pauses on an uncertain result, and rejects reuse of the confirmation', async () => {
    await page.setContent(fixture('greenhouse.html'));
    await trackSubmissions();
    const applicationRunner = runner();
    const fill = await applicationRunner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');
    const confirmation = grant(fill.preview.hash);

    await expect(applicationRunner.submit(fill.preview, confirmation)).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'submission_result_uncertain',
      recoveryAction: 'verify_submission_result',
    });
    await expect(applicationRunner.submit(fill.preview, confirmation)).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'policy_blocked',
    });
    expect(await submitCount()).toBe(1);
  });

  it('does not click when more than one submit target is visible', async () => {
    await page.setContent(`
      <form data-platform="lever">
        <button type="submit">Submit application</button>
        <button type="submit">Submit another application</button>
      </form>
    `);
    await trackSubmissions();

    await expect(
      new PlaywrightApplicationPage(page, { submissionTimeoutMs: 100 }).submitOnce(),
    ).resolves.toEqual({ kind: 'uncertain' });
    expect(await submitCount()).toBe(0);
  });
});
