import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type BrowserContext } from 'playwright';

import { PlaywrightApplicationPage } from './playwright-page.js';

export interface LocalBrowserSessionOptions {
  profileDirectory: string;
  headless?: boolean;
  allowHttpForTesting?: boolean;
  submissionTimeoutMs?: number;
}

export class LocalBrowserSession {
  private constructor(
    private readonly browserContext: BrowserContext,
    private readonly allowHttpForTesting: boolean,
    private readonly submissionTimeoutMs?: number,
  ) {}

  static async start(options: LocalBrowserSessionOptions): Promise<LocalBrowserSession> {
    const profileDirectory = path.resolve(options.profileDirectory);
    await mkdir(profileDirectory, { recursive: true });
    const browserContext = await chromium.launchPersistentContext(profileDirectory, {
      acceptDownloads: false,
      headless: options.headless ?? false,
    });
    return new LocalBrowserSession(
      browserContext,
      options.allowHttpForTesting ?? false,
      options.submissionTimeoutMs,
    );
  }

  async open(targetUrl: string): Promise<PlaywrightApplicationPage> {
    const parsed = new URL(targetUrl);
    if (
      parsed.protocol !== 'https:' &&
      !(this.allowHttpForTesting && parsed.protocol === 'http:')
    ) {
      throw new Error('Only HTTPS target pages are allowed.');
    }
    const page = this.browserContext.pages()[0] ?? (await this.browserContext.newPage());
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded' });
    const finalUrl = new URL(page.url());
    if (
      finalUrl.protocol !== 'https:' &&
      !(this.allowHttpForTesting && finalUrl.protocol === 'http:')
    ) {
      throw new Error('Target page redirected to a non-HTTPS URL.');
    }
    return new PlaywrightApplicationPage(page, {
      ...(this.submissionTimeoutMs === undefined
        ? {}
        : { submissionTimeoutMs: this.submissionTimeoutMs }),
    });
  }

  async close(): Promise<void> {
    await this.browserContext.close();
  }
}
