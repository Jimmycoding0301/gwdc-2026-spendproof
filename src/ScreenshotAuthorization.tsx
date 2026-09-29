import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ArrowDownToLine, Check, ChevronDown, FileImage, ImagePlus, LoaderCircle, ScanLine, ShieldAlert, Undo2, Upload, X } from 'lucide-react';
import type { AuthorizationExtraction } from '../shared/authorization';
import { api } from './api';
import { AUTHORIZATION_KEYS, applyAuthorizationDraft, clipboardImageFiles, parseAuthorizationExtraction, recognizedAuthorizationKeys, sameAuthorizationForm, screenshotFileError } from './screenshot-input';
import type { AuthorizationFormValues, AuthorizationKey } from './screenshot-input';
import { MERCHANTS } from '../shared/types';
import './screenshot.css';

export interface ScreenshotAuthorizationProps {
  value: AuthorizationFormValues;
  onApply: (value: AuthorizationFormValues) => void;
  disabled?: boolean;
}
type SelectedScreenshot = { name: string; size: number; dataUrl: string };
type AppliedChange = { before: AuthorizationFormValues; after: AuthorizationFormValues };
const labels: Record<AuthorizationKey, string> = { task: '任务', budgetMicros: '总预算', durationMinutes: '有效期', allowedMerchants: '登记供应商' };
const confidenceLabels = { high: '高置信度', medium: '中置信度 · 请复核', low: '低置信度 · 需确认' };
const copyValues = (value: AuthorizationFormValues): AuthorizationFormValues => ({ ...value, merchants: [...value.merchants] });
const merchantNames = (merchants: string[]) => merchants.map(id => MERCHANTS.find(merchant => merchant.id === id)?.name || '未登记供应商').join(' / ') || '未选择供应商';

export function ScreenshotAuthorization({ value, onApply, disabled = false }: ScreenshotAuthorizationProps) {
  const id = useId();
  const [selected, setSelected] = useState<SelectedScreenshot | null>(null);
  const [reading, setReading] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<AuthorizationExtraction | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState<AppliedChange | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const reader = useRef<FileReader | null>(null);
  const selectionVersion = useRef(0);
  const dragDepth = useRef(0);

  useEffect(() => () => {
    selectionVersion.current += 1;
    request.current?.abort();
    reader.current?.abort();
  }, []);

  function clearScreenshot() {
    selectionVersion.current += 1;
    request.current?.abort(); request.current = null;
    reader.current?.abort(); reader.current = null;
    dragDepth.current = 0;
    setSelected(null); setResult(null); setError(''); setRecognizing(false); setReading(false); setDragging(false);
    setStatus('截图已清除。表单未变。');
    if (input.current) input.current.value = '';
  }

  const choose = useCallback(async (files: File[]) => {
    if (disabled) return;
    const validationError = screenshotFileError(files);
    if (validationError) { setError(validationError); return; }
    const file = files[0];
    const version = ++selectionVersion.current;
    request.current?.abort(); request.current = null;
    reader.current?.abort();
    setReading(true); setRecognizing(false); setSelected(null); setResult(null); setError(''); setStatus('正在读取截图预览…');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fileReader = new FileReader();
        reader.current = fileReader;
        fileReader.onload = () => typeof fileReader.result === 'string' ? resolve(fileReader.result) : reject(new Error('图片读取失败。'));
        fileReader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
        fileReader.onabort = () => reject(new Error('图片读取已取消。'));
        fileReader.readAsDataURL(file);
      });
      if (version !== selectionVersion.current) return;
      await new Promise<void>((resolve, reject) => {
        const preview = new Image();
        preview.onload = () => preview.naturalWidth > 0 && preview.naturalHeight > 0 ? resolve() : reject(new Error('图片没有有效内容。'));
        preview.onerror = () => reject(new Error('无法解码这张图片，请重新保存为 PNG 或 JPEG。'));
        preview.src = dataUrl;
      });
      if (version !== selectionVersion.current) return;
      setSelected({ name: file.name || '粘贴的截图', size: file.size, dataUrl });
      setStatus('截图已就绪。');
    } catch (reason) {
      if (version === selectionVersion.current) { setError(reason instanceof Error ? reason.message : '图片读取失败。'); setStatus(''); }
    } finally {
      if (version === selectionVersion.current) { reader.current = null; setReading(false); }
    }
  }, [disabled]);

  useEffect(() => {
    function paste(event: ClipboardEvent) {
      if (disabled || event.defaultPrevented) return;
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      void choose(files);
    }
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [choose, disabled]);

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0; setDragging(false);
    void choose(Array.from(event.dataTransfer.files));
  }

  async function recognize() {
    if (!selected || disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
    setRecognizing(true); setResult(null); setError(''); setStatus('正在本机识别。表单未变。');
    try {
      const response = await api<unknown>('/authorization/extract', { method: 'POST', body: JSON.stringify({ imageDataUrl: selected.dataUrl }), signal: controller.signal });
      if (controller.signal.aborted) return;
      const extracted = parseAuthorizationExtraction(response);
      setResult(extracted);
      const count = recognizedAuthorizationKeys(extracted.draft).length;
      setStatus(count ? `识别到 ${count} 项。核对后填入。` : '没有识别到授权字段。');
    } catch (reason) {
      if (request.current === controller && (!controller.signal.aborted || timedOut)) {
        setError(timedOut ? '识别超时。请裁剪后重试。' : reason instanceof Error ? reason.message : '本机识别失败。');
        setStatus('');
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setRecognizing(false); }
    }
  }

  function cancelRecognition() {
    request.current?.abort(); request.current = null;
    setRecognizing(false); setStatus('识别已停止。');
  }

  const next = result ? applyAuthorizationDraft(value, result.draft) : value;
  const recognized = result ? recognizedAuthorizationKeys(result.draft) : [];
  const kept = AUTHORIZATION_KEYS.filter(key => !recognized.includes(key));
  const unchanged = sameAuthorizationForm(value, next);
  const canUndo = applied !== null && sameAuthorizationForm(value, applied.after);
  const shown: Record<AuthorizationKey, string> = { task: next.task || '尚未填写', budgetMicros: `${next.budget || '尚未填写'} USDC（含服务费）`, durationMinutes: `${next.duration || '尚未填写'} 分钟`, allowedMerchants: merchantNames(next.merchants) };

  function apply() {
    if (disabled || !result || recognized.length === 0 || unchanged) return;
    const before = copyValues(value);
    const after = applyAuthorizationDraft(before, result.draft);
    onApply(after);
    setApplied({ before, after: copyValues(after) });
    setStatus('草稿已填入。请核对。');
  }

  function undo() {
    if (disabled || !applied || !canUndo) return;
    onApply(copyValues(applied.before));
    setApplied(null);
    setStatus('已撤销。');
  }

  return <section className="screenshot-authorization" aria-labelledby={`${id}-title`}>
    <header className="sa-heading"><span className="sa-heading-icon"><ScanLine size={19} aria-hidden="true" /></span><div><h3 id={`${id}-title`}>发票截图</h3><p>截图 → 授权草稿</p></div></header>
    <div className={`sa-dropzone ${dragging ? 'sa-dragging' : ''} ${disabled ? 'sa-disabled' : ''}`} tabIndex={disabled ? -1 : 0} role="group" aria-label="截图预览与粘贴区域" aria-describedby={`${id}-input-help`} onDragOver={dragOver} onDrop={drop}
      onDragEnter={event => { if (!disabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onKeyDown={event => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); input.current?.click(); } }}
      onPointerDown={event => { if (event.target === event.currentTarget) event.currentTarget.focus(); }}>
      {selected ? <div className="sa-preview"><img src={selected.dataUrl} alt="待识别的授权截图预览" /><div><FileImage size={14} aria-hidden="true" /><span title={selected.name}>{selected.name}</span><small>{Math.ceil(selected.size / 1024)} KB</small></div></div>
        : <div className="sa-empty">{reading ? <LoaderCircle className="sa-spin" size={27} aria-hidden="true" /> : <ImagePlus size={28} strokeWidth={1.4} aria-hidden="true" />}<strong>{reading ? '正在读取…' : '拖入或粘贴发票截图'}</strong><p>⌘ V / Ctrl V</p></div>}
      <div className="sa-file-actions"><button className="sa-button" type="button" onClick={() => input.current?.click()} disabled={disabled || reading}><Upload size={14} aria-hidden="true" />{selected ? '更换截图' : '选择截图'}</button>{(selected || reading) && <button className="sa-button sa-quiet" type="button" onClick={clearScreenshot}><X size={14} aria-hidden="true" />清除截图</button>}</div>
      <input ref={input} id={`${id}-file`} type="file" accept="image/png,image/jpeg" hidden disabled={disabled} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void choose(files); }} />
      <p id={`${id}-input-help`} className="sa-input-help">PNG / JPEG · 最大 1 MB</p>
    </div>
    <p className="sa-privacy">本机 OCR。图片不进入模型或证据包。</p>
    {selected && <div className="sa-recognition-actions"><button className="sa-button sa-primary" type="button" onClick={() => void recognize()} disabled={disabled || recognizing}>{recognizing ? <LoaderCircle className="sa-spin" size={15} aria-hidden="true" /> : <ScanLine size={15} aria-hidden="true" />}{recognizing ? '本机识别中…' : result ? '重新识别授权字段' : '识别授权字段'}</button>{recognizing && <button type="button" className="sa-button sa-quiet" onClick={cancelRecognition}>取消等待</button>}</div>}
    {disabled && <p className="sa-note">运行结束后可用。</p>}
    {error && <p className="sa-error" role="alert"><ShieldAlert size={15} aria-hidden="true" />{error}</p>}
    <p className="sa-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
    {result && <div className="sa-result">
      <div className="sa-result-heading"><strong>{result.source === 'demo-fixture' ? '演示样例' : 'OCR 结果'}</strong><span>{recognized.length} / 4 项</span></div>
      {result.source === 'demo-fixture' && <p className="sa-warning"><ShieldAlert size={15} aria-hidden="true" />演示数据。</p>}
      <dl className="sa-fields">{AUTHORIZATION_KEYS.map(key => {
        const extracted = recognized.includes(key);
        const field = result.fields.find(item => item.key === key);
        return <div key={key}><dt>{labels[key]}<span className={extracted ? 'sa-from-image' : 'sa-from-form'}>{extracted ? '截图识别' : '保留当前值'}</span></dt><dd>{shown[key]}</dd>{extracted && <dd className={`sa-confidence ${field?.confidence === 'high' ? '' : 'sa-confirm-needed'}`}>{field ? confidenceLabels[field.confidence] : '需要确认'}{field?.evidence && <span> · 原文：{field.evidence}</span>}</dd>}</div>;
      })}</dl>
      {kept.length > 0 && <p className="sa-warning"><ShieldAlert size={15} aria-hidden="true" />未识别：{kept.map(key => labels[key]).join('、')}。将保留当前值。</p>}
      {result.warnings.length > 0 && <ul className="sa-warnings">{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
      {result.fields.length > 0 && <details className="sa-extracted-details"><summary>查看识别字段与原文 <ChevronDown size={13} aria-hidden="true" /></summary><dl>{result.fields.map((field, index) => <div key={`${field.key}-${index}`}><dt>{field.label}<span>{confidenceLabels[field.confidence]}</span></dt><dd>{field.value}</dd>{field.evidence && <dd className="sa-field-evidence">{field.evidence}</dd>}</div>)}</dl></details>}
      {recognized.length === 0 ? <p className="sa-no-fields">裁剪到任务、预算或期限后重试。</p>
        : <><button className="sa-button sa-apply" type="button" disabled={disabled || recognizing || unchanged} onClick={apply}>{unchanged ? <Check size={15} aria-hidden="true" /> : <ArrowDownToLine size={15} aria-hidden="true" />}{unchanged ? '内容一致' : '填入草稿'}</button><p className="sa-note">不会自动运行或付款。</p></>}
    </div>}
    {applied && <div className="sa-undo"><button type="button" className="sa-button" onClick={undo} disabled={disabled || !canUndo}><Undo2 size={14} aria-hidden="true" />撤销填入</button><p>{canUndo ? '恢复上次值。' : '表单已修改，无法自动撤销。'}</p></div>}
  </section>;
}

export default ScreenshotAuthorization;
