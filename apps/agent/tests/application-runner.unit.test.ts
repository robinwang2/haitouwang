import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { LocalApplicationRunner } from '../src/application-runner.js';
import type {
  AnswerValue,
  ApplicationPage,
  ConfirmationGrant,
  ConfirmationVerifier,
  ControlKind,
  DetectedControl,
  PageInspection,
  SubmissionObservation,
  UploadAction,
  ValueAction,
} from '../src/types.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const RESUME_PATH = fileURLToPath(new URL('./fixtures/resume.pdf', import.meta.url));

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

function kind(element: Element): ControlKind {
  const tag = element.tagName.toLowerCase();
  const type = (
    element.getAttribute('type') ?? (tag === 'button' ? 'submit' : 'text')
  ).toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return type === 'submit' ? 'submit' : 'button';
  if (['file', 'checkbox', 'radio', 'password', 'hidden', 'submit'].includes(type)) {
    return type as ControlKind;
  }
  return 'text';
}

class FixturePage implements ApplicationPage {
  readonly values = new Map<string, AnswerValue>();
  readonly uploads = new Map<string, string>();
  submitCount = 0;
  private readonly document: Document;

  constructor(
    html: string,
    private readonly submission: 'confirmed' | 'uncertain' | 'throw' = 'uncertain',
  ) {
    this.document = parseHTML(html).document;
  }

  async inspect(): Promise<PageInspection> {
    const elements = [...this.document.querySelectorAll('input, select, textarea, button')];
    const controls = elements.map((element, index): DetectedControl => {
      const id = element.getAttribute('data-fixture-id') ?? `control-${index}`;
      element.setAttribute('data-fixture-id', id);
      const inputKind = kind(element);
      const htmlFor = element.getAttribute('id');
      const associated = htmlFor
        ? this.document.querySelector(`label[for="${htmlFor}"]`)?.textContent
        : undefined;
      const wrapping = element.closest('label')?.textContent;
      const legend = element.closest('fieldset')?.querySelector('legend')?.textContent;
      const label = [legend, associated, wrapping, element.getAttribute('aria-label')]
        .filter(Boolean)
        .join(' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
      const options =
        inputKind === 'select'
          ? [...element.querySelectorAll('option')].map(
              (option) => option.getAttribute('value') ?? option.textContent?.trim() ?? '',
            )
          : inputKind === 'radio'
            ? [element.getAttribute('value') ?? '']
            : [];
      return {
        id,
        kind: inputKind,
        name: element.getAttribute('name') ?? '',
        label,
        required: element.hasAttribute('required'),
        disabled: element.hasAttribute('disabled'),
        visible: !element.hasAttribute('hidden') && inputKind !== 'hidden',
        options,
        ...(element.getAttribute('accept')
          ? { accept: element.getAttribute('accept') ?? undefined }
          : {}),
        valuePresent: this.values.has(id) || this.uploads.has(id),
        stateDigest: createHash('sha256')
          .update(
            JSON.stringify({
              value: this.values.get(id),
              upload: this.uploads.get(id),
            }),
          )
          .digest('hex'),
      };
    });
    const platform = this.document.querySelector('form')?.getAttribute('data-platform');
    const hazards = this.document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey], input[name*="captcha"]',
    )
      ? (['captcha'] as const)
      : [];
    return {
      url:
        platform === 'greenhouse'
          ? 'https://boards.greenhouse.io/acme/jobs/42'
          : 'https://jobs.lever.co/acme/abc/apply',
      ...(platform === 'greenhouse' || platform === 'lever' ? { platform } : {}),
      controls,
      hazards,
    };
  }

  async setValue(action: ValueAction): Promise<void> {
    this.values.set(action.control.id, action.value);
  }

  async upload(action: UploadAction): Promise<void> {
    this.uploads.set(action.control.id, action.path);
  }

  async submitOnce(): Promise<SubmissionObservation> {
    this.submitCount += 1;
    if (this.submission === 'throw') throw new Error('connection closed after click');
    if (this.submission === 'uncertain') return { kind: 'uncertain' };
    return {
      kind: 'confirmed',
      confirmationNumber: 'GH-12345',
      evidenceDigest: createHash('sha256').update('fixed-success-evidence').digest('hex'),
    };
  }
}

class ChangedPage extends FixturePage {
  private inspectionCount = 0;

  override async inspect(): Promise<PageInspection> {
    this.inspectionCount += 1;
    const inspection = await super.inspect();
    if (this.inspectionCount < 3) return inspection;
    return {
      ...inspection,
      controls: inspection.controls.map((control, index) =>
        index === 0 ? { ...control, label: `${control.label} changed` } : control,
      ),
    };
  }
}

class OneTimeVerifier implements ConfirmationVerifier {
  consumed = false;

  verify(grant: ConfirmationGrant): boolean {
    return grant.token === 'signed-confirmation' && !this.consumed;
  }

  consume(grant: ConfirmationGrant): boolean {
    if (!this.verify(grant)) return false;
    this.consumed = true;
    return true;
  }
}

function grant(previewHash: string): ConfirmationGrant {
  return {
    token: 'signed-confirmation',
    applicationId: 'application-1',
    commandId: 'command-1',
    previewHash,
    expiresAt: '2026-07-31T12:02:00.000Z',
  };
}

describe('LocalApplicationRunner fixed fixtures', () => {
  it('fills and uploads a Greenhouse fixture, then pauses before submit', async () => {
    const page = new FixturePage(fixture('greenhouse.html'));
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);

    const outcome = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });

    expect(outcome).toMatchObject({
      state: 'awaiting_confirmation',
      status: 'paused',
      preview: {
        platform: 'greenhouse',
        filledFields: ['email', 'first_name', 'last_name', 'phone'],
        uploadedMaterials: ['resume'],
      },
    });
    expect(page.values.size).toBe(4);
    expect(page.uploads.size).toBe(1);
    expect(page.submitCount).toBe(0);
  });

  it('fills and uploads a Lever fixture deterministically', async () => {
    const page = new FixturePage(fixture('lever.html'));
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);

    const outcome = await runner.fill({
      answers: {
        full_name: 'Grace Hopper',
        email: 'grace@example.test',
        phone: '+1 555 0101',
        linkedin_url: 'https://www.linkedin.com/in/example',
      },
      materials: { resume: RESUME_PATH },
    });

    expect(outcome).toMatchObject({
      state: 'awaiting_confirmation',
      preview: {
        platform: 'lever',
        filledFields: ['email', 'full_name', 'linkedin_url', 'phone'],
        uploadedMaterials: ['resume'],
      },
    });
    expect(page.submitCount).toBe(0);
  });

  it('stops before any mutation when CAPTCHA is present', async () => {
    const page = new FixturePage(fixture('captcha.html'));
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);

    await expect(
      runner.fill({ answers: { email: 'user@example.test' }, materials: {} }),
    ).resolves.toEqual({
      state: 'manual_intervention_required',
      status: 'manual_intervention_required',
      manualReason: 'captcha',
      recoveryAction: 'user_complete_locally',
    });
    expect(page.values.size).toBe(0);
    expect(page.submitCount).toBe(0);
  });

  it('stops before any mutation for an unknown question', async () => {
    const page = new FixturePage(fixture('unknown-question.html'));
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);

    const outcome = await runner.fill({
      answers: { email: 'user@example.test' },
      materials: {},
    });

    expect(outcome).toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'unknown_required_field',
      recoveryAction: 'user_answer_required',
    });
    expect(page.values.size).toBe(0);
    expect(page.submitCount).toBe(0);
  });

  it('never submits without a current explicit confirmation', async () => {
    const page = new FixturePage(fixture('greenhouse.html'), 'confirmed');
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);
    const fill = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');

    await expect(runner.submit(fill.preview)).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'policy_blocked',
    });
    expect(page.submitCount).toBe(0);
  });

  it('stops before submit when confirmation metadata is invalid', async () => {
    const page = new FixturePage(fixture('greenhouse.html'), 'confirmed');
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);
    const fill = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');

    await expect(
      runner.submit(fill.preview, { ...grant(fill.preview.hash), expiresAt: 'invalid' }),
    ).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'policy_blocked',
    });
    expect(page.submitCount).toBe(0);
  });

  it('invalidates confirmation when the page changes before submit', async () => {
    const page = new ChangedPage(fixture('greenhouse.html'), 'confirmed');
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);
    const fill = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');

    await expect(runner.submit(fill.preview, grant(fill.preview.hash))).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'page_structure_changed',
    });
    expect(page.submitCount).toBe(0);
  });

  it('invalidates confirmation when a non-empty field is replaced with another value', async () => {
    const page = new FixturePage(fixture('greenhouse.html'), 'confirmed');
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);
    const fill = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'approved@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');
    const inspection = await page.inspect();
    const email = inspection.controls.find((control) => control.name.includes('email'));
    if (!email) throw new Error('expected email control');
    page.values.set(email.id, 'altered@example.test');

    await expect(runner.submit(fill.preview, grant(fill.preview.hash))).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'page_structure_changed',
    });
    expect(page.submitCount).toBe(0);
  });

  it('invalidates confirmation when the selected upload changes', async () => {
    const page = new FixturePage(fixture('greenhouse.html'), 'confirmed');
    const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);
    const fill = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');
    const inspection = await page.inspect();
    const resume = inspection.controls.find((control) => control.name.includes('resume'));
    if (!resume) throw new Error('expected resume control');
    page.uploads.set(resume.id, 'locally-replaced-resume.pdf');

    await expect(runner.submit(fill.preview, grant(fill.preview.hash))).resolves.toMatchObject({
      state: 'manual_intervention_required',
      manualReason: 'page_structure_changed',
    });
    expect(page.submitCount).toBe(0);
  });

  it.each(['uncertain', 'throw'] as const)(
    'clicks submit once and safely stops when the result is %s',
    async (submission) => {
      const page = new FixturePage(fixture('greenhouse.html'), submission);
      const runner = new LocalApplicationRunner(page, new OneTimeVerifier(), () => NOW);
      const fill = await runner.fill({
        answers: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.test',
          phone: '+1 555 0100',
        },
        materials: { resume: RESUME_PATH },
      });
      if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');

      await expect(runner.submit(fill.preview, grant(fill.preview.hash))).resolves.toEqual({
        state: 'manual_intervention_required',
        status: 'manual_intervention_required',
        manualReason: 'submission_result_uncertain',
        recoveryAction: 'verify_submission_result',
      });
      expect(page.submitCount).toBe(1);
    },
  );

  it('submits once after consuming confirmation and returns verified evidence', async () => {
    const page = new FixturePage(fixture('greenhouse.html'), 'confirmed');
    const verifier = new OneTimeVerifier();
    const runner = new LocalApplicationRunner(page, verifier, () => NOW);
    const fill = await runner.fill({
      answers: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        phone: '+1 555 0100',
      },
      materials: { resume: RESUME_PATH },
    });
    if (fill.state !== 'awaiting_confirmation') throw new Error('expected preview');

    const outcome = await runner.submit(fill.preview, grant(fill.preview.hash));
    expect(outcome).toMatchObject({
      state: 'completed',
      status: 'completed',
      confirmationNumber: 'GH-12345',
    });
    expect(page.submitCount).toBe(1);
    expect(verifier.consumed).toBe(true);
  });
});
