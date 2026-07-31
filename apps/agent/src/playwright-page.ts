import { createHash } from 'node:crypto';

import type { Locator, Page } from 'playwright';

import type {
  AnswerValue,
  ApplicationPage,
  ControlKind,
  DetectedControl,
  ManualReason,
  PageInspection,
  SubmissionObservation,
  SupportedPlatform,
  UploadAction,
  ValueAction,
} from './types.js';

interface RawControl {
  id: string;
  tag: string;
  type: string;
  name: string;
  label: string;
  required: boolean;
  disabled: boolean;
  visible: boolean;
  options: string[];
  accept?: string;
  valuePresent: boolean;
}

const CAPTCHA_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  '[data-sitekey]',
  'input[name*="captcha" i]',
].join(',');

function detectPlatform(
  url: string,
  rawControls: readonly RawControl[],
  formSignals: string,
): SupportedPlatform | undefined {
  const value = `${url} ${formSignals} ${rawControls.map((control) => control.name).join(' ')}`;
  if (/greenhouse|grnh\.se|job_application/i.test(value)) return 'greenhouse';
  if (/lever\.co|lever|application-form/i.test(value)) return 'lever';
  return undefined;
}

function kindOf(raw: RawControl): ControlKind {
  if (raw.tag === 'textarea') return 'textarea';
  if (raw.tag === 'select') return 'select';
  if (raw.tag === 'button') return raw.type === 'submit' ? 'submit' : 'button';
  if (raw.type === 'submit') return 'submit';
  if (raw.type === 'button' || raw.type === 'reset') return 'button';
  if (raw.type === 'file') return 'file';
  if (raw.type === 'checkbox') return 'checkbox';
  if (raw.type === 'radio') return 'radio';
  if (raw.type === 'password') return 'password';
  if (raw.type === 'hidden') return 'hidden';
  return 'text';
}

function toControl(raw: RawControl): DetectedControl {
  return {
    id: raw.id,
    kind: kindOf(raw),
    name: raw.name,
    label: raw.label,
    required: raw.required,
    disabled: raw.disabled,
    visible: raw.visible,
    options: raw.options,
    ...(raw.accept ? { accept: raw.accept } : {}),
    valuePresent: raw.valuePresent,
  };
}

function hazardFromText(text: string): ManualReason | undefined {
  if (/\b(?:captcha|verify you are human|security challenge)\b/i.test(text)) return 'captcha';
  if (/\b(?:coding assessment|online assessment|take-home test)\b/i.test(text)) {
    return 'assessment';
  }
  if (/\b(?:video interview|record a video|video response)\b/i.test(text)) {
    return 'video_interview';
  }
  return undefined;
}

function stringifyValue(value: AnswerValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export interface PlaywrightApplicationPageOptions {
  submissionTimeoutMs?: number;
}

export class PlaywrightApplicationPage implements ApplicationPage {
  private readonly controls = new Map<string, Locator>();
  private readonly submissionTimeoutMs: number;

  constructor(
    private readonly page: Page,
    options: PlaywrightApplicationPageOptions = {},
  ) {
    this.submissionTimeoutMs = options.submissionTimeoutMs ?? 10_000;
  }

  async inspect(): Promise<PageInspection> {
    const locator = this.page.locator('input, select, textarea, button');
    const formSignals = await this.page
      .locator('form')
      .evaluateAll((forms) =>
        forms
          .flatMap((form) => [
            form.getAttribute('action') ?? '',
            form.getAttribute('data-platform') ?? '',
            form.getAttribute('id') ?? '',
            form.getAttribute('class') ?? '',
          ])
          .join(' '),
      );
    const rawControls = await locator.evaluateAll((elements) =>
      elements.map((element, index) => {
        const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        let id = element.getAttribute('data-haitouwang-control-id');
        if (!id) {
          id = `control-${index}`;
          element.setAttribute('data-haitouwang-control-id', id);
        }
        const htmlElement = element as HTMLElement;
        const labels = 'labels' in control && control.labels ? [...control.labels] : [];
        const legend = element.closest('fieldset')?.querySelector('legend')?.textContent ?? '';
        const ariaLabel = element.getAttribute('aria-label') ?? '';
        const placeholder = element.getAttribute('placeholder') ?? '';
        const label = [
          legend,
          ...labels.map((item) => item.textContent ?? ''),
          ariaLabel,
          placeholder,
        ]
          .map((item) => item.replaceAll(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ');
        let visible = true;
        let ancestor: HTMLElement | null = htmlElement;
        while (ancestor) {
          const style = window.getComputedStyle(ancestor);
          if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden') {
            visible = false;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const tag = element.tagName.toLowerCase();
        const type = (
          element.getAttribute('type') ?? (tag === 'button' ? 'submit' : 'text')
        ).toLowerCase();
        const options =
          element instanceof HTMLSelectElement
            ? [...element.options].map((option) => option.value || option.textContent?.trim() || '')
            : type === 'radio'
              ? [control.value]
              : [];
        const valuePresent =
          type === 'checkbox' || type === 'radio'
            ? (control as HTMLInputElement).checked
            : type === 'file'
              ? Boolean((control as HTMLInputElement).files?.length)
              : Boolean(control.value);
        return {
          id,
          tag,
          type,
          name: control.name ?? '',
          label,
          required: control.required,
          disabled: control.disabled,
          visible,
          options,
          accept: element.getAttribute('accept') ?? undefined,
          valuePresent,
        };
      }),
    );

    this.controls.clear();
    for (const raw of rawControls) {
      this.controls.set(
        raw.id,
        this.page.locator(`[data-haitouwang-control-id="${raw.id}"]`).first(),
      );
    }

    const hazards: ManualReason[] = [];
    if ((await this.page.locator(CAPTCHA_SELECTOR).count()) > 0) hazards.push('captcha');
    const bodyText = await this.page
      .locator('body')
      .innerText()
      .catch(() => '');
    const textHazard = hazardFromText(bodyText);
    if (textHazard && !hazards.includes(textHazard)) hazards.push(textHazard);

    return {
      url: this.page.url(),
      platform: detectPlatform(this.page.url(), rawControls, formSignals),
      controls: rawControls.map(toControl),
      hazards,
    };
  }

  async setValue(action: ValueAction): Promise<void> {
    const locator = this.control(action.control.id);
    if (action.control.kind === 'select') {
      const value = stringifyValue(action.value);
      await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
      return;
    }
    if (action.control.kind === 'checkbox') {
      await locator.setChecked(Boolean(action.value));
      return;
    }
    if (action.control.kind === 'radio') {
      if (action.control.options.includes(stringifyValue(action.value))) await locator.check();
      return;
    }
    await locator.fill(stringifyValue(action.value));
  }

  async upload(action: UploadAction): Promise<void> {
    await this.control(action.control.id).setInputFiles(action.path);
  }

  async submitOnce(): Promise<SubmissionObservation> {
    const submit = this.page.locator('button[type="submit"], input[type="submit"]').first();
    if (
      (await submit.count()) !== 1 ||
      !(await submit.isVisible()) ||
      !(await submit.isEnabled())
    ) {
      return { kind: 'uncertain' };
    }

    await submit.click({ noWaitAfter: true });
    await this.page
      .waitForLoadState('domcontentloaded', { timeout: this.submissionTimeoutMs })
      .catch(() => undefined);

    const url = this.page.url();
    const bodyText = await this.page
      .locator('body')
      .innerText()
      .catch(() => '');
    const success =
      /thank you for applying|application (?:has been )?submitted|application received/i.exec(
        bodyText,
      );
    const confirmation =
      /(?:confirmation(?:\s*(?:number|id|#))?|application\s*(?:number|id|#)|reference\s*(?:number|id|#))\s*[:#-]\s*([A-Z0-9-]{5,})/i.exec(
        bodyText,
      )?.[1];
    if (!success && !confirmation) return { kind: 'uncertain' };

    const evidenceDigest = createHash('sha256')
      .update(JSON.stringify({ url, marker: success?.[0].toLowerCase(), confirmation }))
      .digest('hex');
    return {
      kind: 'confirmed',
      ...(confirmation ? { confirmationNumber: confirmation } : {}),
      evidenceDigest,
    };
  }

  private control(id: string): Locator {
    const locator = this.controls.get(id);
    if (!locator) throw new Error('PAGE_STRUCTURE_CHANGED');
    return locator;
  }
}
