import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthorizationText } from '../shared/authorization.js';
import type { AuthorizationExtraction, RecognizedLine } from '../shared/authorization.js';

export const AUTHORIZATION_IMAGE_LIMIT = 1_048_576;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 12_000_000;
const OCR_TIMEOUT_MS = 30_000;
const OCR_MAX_OUTPUT = 131_072;
export interface AuthorizationImage { bytes: Buffer; mime: 'image/png' | 'image/jpeg'; width: number; height: number }
export type LocalOcrRunner = (image: AuthorizationImage) => Promise<RecognizedLine[]>;
type ErrorCode = 'INVALID_IMAGE' | 'IMAGE_TOO_LARGE' | 'OCR_UNAVAILABLE' | 'OCR_TIMEOUT' | 'OCR_BUSY' | 'OCR_FAILED';
const messages: Record<ErrorCode, string> = {
  INVALID_IMAGE: '请选择有效的 PNG 或 JPEG 图片，其他格式和远程图片链接不受支持。',
  IMAGE_TOO_LARGE: '图片须不超过 1 MiB，边长不超过 8192 像素，总像素不超过 1200 万。',
  OCR_UNAVAILABLE: '此设备的本地 OCR 不可用，请手动填写授权；图片不会发送给第三方。',
  OCR_TIMEOUT: '本地识别超时，请裁剪图片后重试或手动填写授权。',
  OCR_BUSY: '本地识别正在处理另一张图片，请稍后再试。',
  OCR_FAILED: '本地无法识别这张图片，请换用清晰截图或手动填写授权。',
};
export class AuthorizationExtractionError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
    this.name = 'AuthorizationExtractionError';
    this.status = code === 'IMAGE_TOO_LARGE' ? 413 : code === 'OCR_UNAVAILABLE' ? 503
      : code === 'OCR_TIMEOUT' ? 504 : code === 'OCR_BUSY' ? 429 : code === 'INVALID_IMAGE' ? 400 : 422;
  }
}
function invalid(): never { throw new AuthorizationExtractionError('INVALID_IMAGE'); }
function dimensions(width: number, height: number) {
  if (!width || !height) invalid();
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new AuthorizationExtractionError('IMAGE_TOO_LARGE');
  return { width, height };
}
function pngSize(bytes: Buffer) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  let offset = 8, data = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    if (type === 'IDAT' && length > 0) data = true;
    if (type === 'IEND') { if (length !== 0 || offset + 12 !== bytes.length) invalid(); ended = true; break; }
    offset += length + 12;
  }
  if (!data || !ended) invalid();
  return size;
}
function jpegSize(bytes: Buffer) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid();
  let offset = 2;
  let size: { width: number; height: number } | undefined;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) { if (!size) invalid(); return size; }
    if (marker === 0xd9 || marker === 0 || marker === 0xd8 || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) invalid();
      if (size) invalid();
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return invalid();
}

/** Validates bytes before ImageIO sees them. Actual image decoding is still required by the OCR worker. */
export function validateAuthorizationImage(body: unknown): AuthorizationImage {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'imageDataUrl')) invalid();
  const value = (body as { imageDataUrl?: unknown }).imageDataUrl;
  if (typeof value !== 'string') invalid();
  if (value.length > Math.ceil(AUTHORIZATION_IMAGE_LIMIT / 3) * 4 + 32) throw new AuthorizationExtractionError('IMAGE_TOO_LARGE');
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) invalid();
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) invalid();
  if (bytes.length > AUTHORIZATION_IMAGE_LIMIT) throw new AuthorizationExtractionError('IMAGE_TOO_LARGE');
  const mime = match[1] as AuthorizationImage['mime'];
  const size = mime === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  return { bytes, mime, ...size };
}

let busy = false;
/** Uses Apple Vision locally. No shell, network tools, inherited credentials or permanent image storage. */
export const runLocalOcr: LocalOcrRunner = async image => {
  if (process.platform !== 'darwin') throw new AuthorizationExtractionError('OCR_UNAVAILABLE');
  if (busy) throw new AuthorizationExtractionError('OCR_BUSY');
  busy = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'spendproof-ocr-'));
    await chmod(directory, 0o700);
    const path = join(directory, image.mime === 'image/png' ? 'input.png' : 'input.jpg');
    await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 });
    const script = fileURLToPath(new URL('./ocr-vision.swift', import.meta.url));
    const output = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/swift', ['-module-cache-path', join(directory!, 'module-cache'), script, path], {
        timeout: OCR_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: OCR_MAX_OUTPUT,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: directory! }, encoding: 'utf8',
      }, (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(new AuthorizationExtractionError(code === 'ENOENT' ? 'OCR_UNAVAILABLE' : error.killed ? 'OCR_TIMEOUT' : 'OCR_FAILED'));
        } else resolve(stdout);
      });
    });
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1
      || !Array.isArray((parsed as { lines?: unknown }).lines)) throw new AuthorizationExtractionError('OCR_FAILED');
    return (parsed as { lines: RecognizedLine[] }).lines;
  } catch (error) {
    if (error instanceof AuthorizationExtractionError) throw error;
    throw new AuthorizationExtractionError('OCR_FAILED');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    busy = false;
  }
};

export async function extractAuthorization(body: unknown, options: { ocr?: LocalOcrRunner; protectedValues?: readonly string[] } = {}): Promise<AuthorizationExtraction> {
  const image = validateAuthorizationImage(body);
  try {
    const lines = await (options.ocr ?? runLocalOcr)(image);
    return parseAuthorizationText(lines, options.protectedValues);
  } catch (error) {
    if (error instanceof AuthorizationExtractionError) throw error;
    throw new AuthorizationExtractionError('OCR_FAILED');
  }
}
