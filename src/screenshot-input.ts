import type { AuthorizationDraft, AuthorizationExtraction } from '../shared/authorization';

export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export const AUTHORIZATION_KEYS = ['task', 'budgetMicros', 'durationMinutes', 'allowedMerchants'] as const;
export type AuthorizationKey = typeof AUTHORIZATION_KEYS[number];

export interface AuthorizationFormValues {
  task: string;
  budget: string;
  duration: string;
  merchants: string[];
}

export function screenshotFileError(files: readonly Pick<File, 'type' | 'size'>[]): string | null {
  if (files.length !== 1) return '请一次选择或粘贴一张截图。';
  const file = files[0];
  if (!SCREENSHOT_MIME_TYPES.includes(file.type as typeof SCREENSHOT_MIME_TYPES[number])) return '只支持 PNG 或 JPEG 图片，请先将截图保存为这两种格式。';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return '这张图片是空文件，无法识别。';
  if (file.size > SCREENSHOT_MAX_BYTES) return '图片超过 1 MB，请裁剪到授权内容后再试。';
  return null;
}

/** Text-only clipboard events are deliberately left to their focused input. */
export function clipboardImageFiles(data: Pick<DataTransfer, 'files' | 'items'> | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files).filter(file => file.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(data.items).filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fail closed at the UI boundary; unrecognized merchants cannot become form permissions. */
export function parseAuthorizationExtraction(value: unknown): AuthorizationExtraction {
  const invalid = () => new Error('识别结果格式无效，未填入任何授权字段。');
  if (!object(value) || !object(value.draft) || !Array.isArray(value.fields) || !Array.isArray(value.warnings)
    || !['local-ocr', 'demo-fixture'].includes(String(value.source))) throw invalid();
  const draft = value.draft;
  if (Object.keys(draft).some(key => !AUTHORIZATION_KEYS.includes(key as AuthorizationKey))) throw invalid();
  if (draft.task !== undefined && (typeof draft.task !== 'string' || !draft.task.trim() || draft.task.length > 1000)) throw invalid();
  if (draft.budgetMicros !== undefined && (typeof draft.budgetMicros !== 'number' || !Number.isSafeInteger(draft.budgetMicros)
    || draft.budgetMicros <= 0 || draft.budgetMicros > 100_000_000_000)) throw invalid();
  if (draft.durationMinutes !== undefined && ![15, 60, 1440].includes(draft.durationMinutes as number)) throw invalid();
  if (draft.allowedMerchants !== undefined && (!Array.isArray(draft.allowedMerchants)
    || draft.allowedMerchants.length > 2 || new Set(draft.allowedMerchants).size !== draft.allowedMerchants.length
    || draft.allowedMerchants.some(id => id !== 'atlas' && id !== 'orbit'))) throw invalid();
  if (value.fields.length > 20 || value.fields.some(field => !object(field) || typeof field.key !== 'string'
    || typeof field.label !== 'string' || typeof field.value !== 'string' || field.label.length > 200 || field.value.length > 2000
    || !['high', 'medium', 'low'].includes(String(field.confidence))
    || (field.evidence !== undefined && (typeof field.evidence !== 'string' || field.evidence.length > 2000)))) throw invalid();
  if (value.warnings.length > 30 || value.warnings.some(warning => typeof warning !== 'string' || warning.length > 2000)) throw invalid();
  return structuredClone(value) as unknown as AuthorizationExtraction;
}

export function recognizedAuthorizationKeys(draft: AuthorizationDraft): AuthorizationKey[] {
  return AUTHORIZATION_KEYS.filter(key => draft[key] !== undefined);
}

/** Converts integer micro-USDC exactly, without truncating sub-cent screenshot amounts. */
export function microsToFormBudget(value: number): string {
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** Only called after the user's explicit apply action; missing fields retain the shown form value. */
export function applyAuthorizationDraft(current: AuthorizationFormValues, draft: AuthorizationDraft): AuthorizationFormValues {
  return {
    task: draft.task ?? current.task,
    budget: draft.budgetMicros === undefined ? current.budget : microsToFormBudget(draft.budgetMicros),
    duration: draft.durationMinutes === undefined ? current.duration : String(draft.durationMinutes),
    merchants: [...(draft.allowedMerchants ?? current.merchants)],
  };
}

export function sameAuthorizationForm(a: AuthorizationFormValues, b: AuthorizationFormValues): boolean {
  return a.task === b.task && a.budget === b.budget && a.duration === b.duration
    && a.merchants.length === b.merchants.length && a.merchants.every((id, index) => id === b.merchants[index]);
}
