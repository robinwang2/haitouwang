import type {
  CanonicalField,
  DetectedControl,
  ManualReason,
  PageInspection,
  SupportedPlatform,
} from './types.js';

export interface RecognizedControl {
  control: DetectedControl;
  field: CanonicalField;
}

export interface RecognitionResult {
  platform?: SupportedPlatform;
  fields: readonly RecognizedControl[];
  ignored: readonly DetectedControl[];
  manualReason?: ManualReason;
}

const FIELD_PATTERNS: readonly [CanonicalField, readonly RegExp[]][] = [
  ['resume', [/\bresume\b/i, /\bcv\b/i]],
  ['cover_letter', [/cover.?letter/i]],
  ['first_name', [/first.?name/i, /given.?name/i]],
  ['last_name', [/last.?name/i, /family.?name/i, /surname/i]],
  ['full_name', [/full.?name/i, /^name$/i]],
  ['email', [/e-?mail/i]],
  ['phone', [/phone/i, /mobile/i]],
  ['linkedin_url', [/linkedin/i]],
  ['github_url', [/github/i]],
  ['website_url', [/website/i, /portfolio/i, /personal.?url/i]],
  ['current_company', [/current.?company/i, /organization/i]],
  ['address', [/street.?address/i, /^address$/i]],
  ['city', [/\bcity\b/i]],
  ['state', [/state.*province/i, /^state$/i, /^province$/i]],
  ['postal_code', [/postal/i, /zip.?code/i]],
  ['country', [/\bcountry\b/i]],
];

const WORK_AUTHORIZATION = [
  /authori[sz]ed to work/i,
  /work authori[sz]ation/i,
  /visa sponsorship/i,
  /require sponsorship/i,
];
const LEGAL_OR_IDENTITY = [
  /social security/i,
  /national ident/i,
  /government.?id/i,
  /date of birth/i,
  /criminal background/i,
  /veteran/i,
  /disability/i,
  /race|ethnicity|gender/i,
];
const ELECTRONIC_SIGNATURE = [/electronic signature/i, /type.*legal name.*sign/i];
const ASSESSMENT = [/assessment/i, /coding test/i, /take.?home/i];
const VIDEO = [/video (?:interview|response|recording)/i, /record.*video/i];

function searchable(control: DetectedControl): string {
  return `${control.name} ${control.label}`.replaceAll(/[_-]+/g, ' ').trim();
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function classifyRisk(control: DetectedControl): ManualReason | undefined {
  const value = searchable(control);
  if (control.kind === 'password') return 'credential_required';
  if (matchesAny(value, WORK_AUTHORIZATION)) return 'work_authorization_ambiguous';
  if (matchesAny(value, ELECTRONIC_SIGNATURE)) return 'electronic_signature';
  if (matchesAny(value, ASSESSMENT)) return 'assessment';
  if (matchesAny(value, VIDEO)) return 'video_interview';
  if (matchesAny(value, LEGAL_OR_IDENTITY)) return 'legal_or_identity_question';
  return undefined;
}

function mapField(control: DetectedControl): CanonicalField | undefined {
  const value = searchable(control);
  return FIELD_PATTERNS.find(([, patterns]) => matchesAny(value, patterns))?.[0];
}

export function recognizeApplicationForm(inspection: PageInspection): RecognitionResult {
  const visibleControls = inspection.controls.filter(
    (control) => control.visible && !control.disabled && control.kind !== 'hidden',
  );
  const ignored = visibleControls.filter(
    (control) => control.kind === 'button' || control.kind === 'submit',
  );
  const interactive = visibleControls.filter(
    (control) => control.kind !== 'button' && control.kind !== 'submit',
  );

  const hazard = inspection.hazards[0];
  if (hazard) return { platform: inspection.platform, fields: [], ignored, manualReason: hazard };

  for (const control of interactive) {
    const risk = classifyRisk(control);
    if (risk) return { platform: inspection.platform, fields: [], ignored, manualReason: risk };
  }

  const fields: RecognizedControl[] = [];
  for (const control of interactive) {
    const field = mapField(control);
    if (!field) {
      return {
        platform: inspection.platform,
        fields: [],
        ignored,
        manualReason: 'unknown_required_field',
      };
    }
    fields.push({ control, field });
  }

  if (!inspection.platform) {
    return { fields: [], ignored, manualReason: 'page_structure_changed' };
  }

  return { platform: inspection.platform, fields, ignored };
}
