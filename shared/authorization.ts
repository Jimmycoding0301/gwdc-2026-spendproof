import { MERCHANTS } from './types';

/** Local OCR produces a draft only. Nothing here authorizes or executes a purchase. */
export type AuthorizationDuration = 15 | 60 | 1440;
export interface AuthorizationDraft {
  task?: string;
  budgetMicros?: number;
  durationMinutes?: AuthorizationDuration;
  allowedMerchants?: ('atlas' | 'orbit')[];
}
export interface AuthorizationField {
  key: keyof AuthorizationDraft;
  label: string;
  value: string;
  confidence: 'high' | 'medium' | 'low';
  evidence?: string;
}
export interface AuthorizationExtraction {
  draft: AuthorizationDraft;
  fields: AuthorizationField[];
  warnings: string[];
  source: 'local-ocr' | 'demo-fixture';
}
export interface RecognizedLine { text: string; confidence?: number }

const labels = {
  task: /^(?:task|purpose|任务|任务描述|采购任务|需求|购买目的)\s*[:：]\s*(.*)$/iu,
  budgetMicros: /^(?:total\s+budget|grand\s+total|total|budget|总预算|预算上限|预算|授权额度|含费总额|总额|合计)\s*[:：]?\s*(.*)$/iu,
  durationMinutes: /^(?:duration|valid\s+for|有效期|授权时长|时长)\s*[:：]?\s*(.*)$/iu,
  allowedMerchants: /^(?:allowed\s+merchants?|merchants?|允许商户|授权商户|商户|服务商)\s*[:：]\s*(.*)$/iu,
} satisfies Record<keyof AuthorizationDraft, RegExp>;
const fieldLabels: Record<keyof AuthorizationDraft, string> = {
  task: '任务', budgetMicros: '预算（含服务费）', durationMinutes: '授权时长', allowedMerchants: '登记供应商',
};
const sensitivePattern = /api[\s_-]*key|secret|private[\s_-]*key|bearer|password|密码|私钥|密钥|token\s*[:=]|seed[\s_-]*phrase|助记词|sk[-_][a-z0-9_-]{8,}|0x[a-f0-9]{64}\b|[a-z0-9_+/=-]{32,}|https?:\/\//iu;
const looksSensitive = (text: string) => sensitivePattern.test(text.replace(/\b0x[a-fA-F0-9]{40}\b/g, '[public-address]'));
const known = (text: string, protectedValues: readonly string[]) => protectedValues.some(value => value.length > 0
  && (text.includes(value) || text.replace(/\s/g, '').includes(value.replace(/\s/g, ''))));

/** Amount conversion uses decimal digits, never binary floating-point multiplication. */
function budget(text: string): number | undefined {
  const match = /^(?:USDC\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,6})?)\s*(USDC)?$/i.exec(text);
  if (!match || (!/^USDC\s/i.test(text) && !match[2])) return;
  if (match[1].includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/.test(match[1])) return;
  const [whole, fraction = ''] = match[1].replaceAll(',', '').split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n || amount > 100_000_000_000n) return;
  return Number(amount);
}

function duration(text: string): AuthorizationDuration | undefined {
  const match = /^(\d+)\s*(minutes?|mins?|m|分钟|分|hours?|hrs?|h|小时|天|days?|d)$/iu.exec(text);
  if (!match) return;
  const unit = match[2].toLowerCase();
  const factor = /^(hours?|hrs?|h|小时)$/.test(unit) ? 60 : /^(天|days?|d)$/.test(unit) ? 1440 : 1;
  const amount = Number(match[1]) * factor;
  return amount === 15 || amount === 60 || amount === 1440 ? amount : undefined;
}

function merchants(text: string): ('atlas' | 'orbit')[] | undefined {
  const pieces = text.split(/[,，、;；/|]|\s+&\s+|\s+and\s+|\s*和\s*/iu).map(value => value.trim()).filter(Boolean);
  if (!pieces.length || pieces.length > 2) return;
  const ids: ('atlas' | 'orbit')[] = [];
  for (const piece of pieces) {
    if (/^(?:vinapack(?:\s+packaging)?|atlas(?:\s+data)?)$/i.test(piece)) ids.push('atlas');
    else if (/^(?:hanbridge(?:\s+logistics)?|orbit(?:\s+research)?)$/i.test(piece)) ids.push('orbit');
    else return;
  }
  return [...new Set(ids)];
}

/** Never returns raw OCR, credential-looking lines, unknown merchants or guessed currencies/timezones. */
export function parseAuthorizationText(input: string | readonly RecognizedLine[], protectedValues: readonly string[] = []): AuthorizationExtraction {
  const result: AuthorizationExtraction = { draft: {}, fields: [], warnings: [], source: 'local-ocr' };
  const supplied: readonly RecognizedLine[] = typeof input === 'string' ? input.split(/\r?\n/).map(text => ({ text })) : input;
  if (!Array.isArray(supplied) || supplied.length > 256) throw new Error('Invalid local OCR output.');
  const lines: RecognizedLine[] = supplied.map(line => {
    if (!line || typeof line.text !== 'string' || line.text.length > 2000
      || (line.confidence !== undefined && (!Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1))) {
      throw new Error('Invalid local OCR output.');
    }
    return { text: line.text.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim(), confidence: line.confidence };
  }).filter(line => line.text);
  if (lines.reduce((sum, line) => sum + line.text.length, 0) > 24_000) throw new Error('Invalid local OCR output.');
  const secretLines = new Set<number>();
  lines.forEach((line, index) => {
    if (looksSensitive(line.text) || known(line.text, protectedValues)) {
      secretLines.add(index);
      // A standalone credential label can precede its value on another OCR line.
      if (/[:：=]\s*$/.test(line.text)) secretLines.add(index + 1);
    }
  });
  if (secretLines.size) result.warnings.push('已忽略可能包含凭据的文字，不会用于授权草稿。');
  const knownAddresses = new Map(MERCHANTS.map(merchant => [merchant.id, merchant.recipient.toLowerCase()]));
  let addressMismatch = false;
  lines.forEach((line, index) => {
    if (secretLines.has(index)) return;
    const ids = (['atlas', 'orbit'] as const).filter(id => new RegExp(`\\b${id}\\b`, 'i').test(line.text));
    if (!ids.length) return;
    const nearby = `${line.text} ${secretLines.has(index + 1) ? '' : lines[index + 1]?.text || ''}`;
    const addresses = nearby.match(/0x[a-fA-F0-9]{40}\b/g) || [];
    if (addresses.some(address => !ids.some(id => address.toLowerCase() === knownAddresses.get(id)))) addressMismatch = true;
  });
  if (addressMismatch)
    result.warnings.push('收款地址不匹配：与供应商登记钱包不同。未自动授权。');
  const values = new Map<keyof AuthorizationDraft, { text: string; evidence: string; confidence?: number }[]>();
  lines.forEach((line, index) => {
    if (secretLines.has(index)) return;
    for (const [rawKey, pattern] of Object.entries(labels)) {
      const key = rawKey as keyof AuthorizationDraft;
      const match = pattern.exec(line.text);
      if (!match) continue;
      let text = match[1].trim();
      let evidence = line.text;
      let confidence = line.confidence;
      if (!text && lines[index + 1] && !secretLines.has(index + 1)
        && !Object.values(labels).some(label => label.test(lines[index + 1].text))) {
        text = lines[index + 1].text;
        evidence += ` ${text}`;
        confidence = Math.min(confidence ?? 0.7, lines[index + 1].confidence ?? 0.7);
      }
      if (text) values.set(key, [...(values.get(key) || []), { text, evidence, confidence }]);
    }
  });
  for (const [key, candidates] of values) {
    if (candidates.length !== 1) { result.warnings.push(`${fieldLabels[key]}出现多处，未自动选择，请手动确认。`); continue; }
    const candidate = candidates[0];
    let display: string | undefined;
    if (key === 'task') {
      if (candidate.text.length <= 240) { result.draft.task = candidate.text; display = candidate.text; }
      else result.warnings.push('任务文字过长，未自动填入，请手动缩写。');
    } else if (key === 'budgetMicros') {
      const amount = budget(candidate.text);
      if (amount !== undefined) { result.draft.budgetMicros = amount; display = `${amount / 1_000_000} USDC`; }
      else result.warnings.push('预算须明确为 USDC、大于零，最多 6 位小数且不超过 100,000 USDC；USD、USDT 和其他币种不会自动换算。');
    } else if (key === 'durationMinutes') {
      const amount = duration(candidate.text);
      if (amount !== undefined) { result.draft.durationMinutes = amount; display = `${amount} 分钟`; }
      else result.warnings.push('只支持明确的 15 分钟、1 小时或 24 小时时长；日期、时区及其他时长请手动确认。');
    } else {
      const ids = addressMismatch ? undefined : merchants(candidate.text);
      if (ids) { result.draft.allowedMerchants = ids; display = ids.map(id => MERCHANTS.find(merchant => merchant.id === id)?.name || id).join(' / '); }
      else result.warnings.push('供应商未匹配 VinaPack / HanBridge 演示登记表，未自动授权未知收款方。');
    }
    if (display !== undefined) result.fields.push({ key, label: fieldLabels[key], value: display,
      confidence: candidate.confidence === undefined ? 'medium' : candidate.confidence >= 0.9 ? 'high' : candidate.confidence >= 0.6 ? 'medium' : 'low',
      evidence: candidate.evidence.slice(0, 180) });
  }
  if (result.draft.budgetMicros !== undefined && lines.some(line => /(?:service\s+fee|fees?|手续费|服务费)\s*[:：]/iu.test(line.text))) {
    result.warnings.push('截图同时包含费用字段；草稿采用明确标注的预算或总额，请核对该金额已包含服务费，未另行自动加费。');
  }
  if (!result.fields.length) result.warnings.push('未识别到明确的授权字段，请使用更清晰的截图或手动填写。');
  if (result.fields.some(field => field.confidence === 'low')) result.warnings.push('部分文字识别置信度较低，请对照截图逐项确认。');
  result.warnings.push('识别结果只是草稿；确认后仅填入表单，不创建任务、不调用模型、不付款。');
  if (known(JSON.stringify(result), protectedValues)) throw new Error('Protected content cannot be included in an authorization draft.');
  return result;
}
