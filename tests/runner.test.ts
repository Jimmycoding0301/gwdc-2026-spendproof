import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quote, Session } from '../shared/types';

// Import neither real configuration nor the disk-backed store. Every request is
// intercepted before it can reach a network, using only a test placeholder key.
vi.mock('../server/config.js', () => ({ config: {
  kilnApiKey: 'test-placeholder', kilnBaseUrl: 'http://127.0.0.1:9999/v1',
  kilnModel: 'qwen3-32b', kilnMaxTokens: 4096,
} }));
vi.mock('../server/store.js', () => ({ persistSessions: vi.fn().mockResolvedValue(undefined) }));

import { hasActiveRun, startRun, stopRun } from '../server/runner';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type RequestMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] };
type ModelRequest = {
  model: string; messages: RequestMessage[]; tool_choice: string; max_tokens: number;
  stream: boolean; tools: { function: { name: string; description: string } }[];
};
const fetchMock = vi.fn<typeof fetch>();
const now = '2026-09-28T12:00:00.000Z';

function session(): Session {
  return {
    id: randomUUID(), title: 'Mock supplier payment', createdAt: now,
    policy: { task: 'Pay two supplier invoices', budgetMicros: 10_000_000,
      allowedMerchants: ['atlas', 'orbit'], expiresAt: '2026-09-28T13:00:00.000Z' },
    scenario: 'normal', agentMode: 'kiln', status: 'ready', records: [], events: [], usage: [],
  };
}

function requestBody(init?: RequestInit): ModelRequest {
  return JSON.parse(String(init?.body)) as ModelRequest;
}

function toolResponse(name: string, args: unknown = {}, options: { truncated?: boolean; usage?: boolean } = {}) {
  return Response.json({
    model: 'qwen3-32b',
    choices: [{ message: { content: null, tool_calls: [{
      id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
    }] }, finish_reason: options.truncated ? 'length' : 'tool_calls' }],
    ...(options.usage === false ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  });
}

function returnedQuote(body: ModelRequest): Quote | undefined {
  for (const message of body.messages) {
    if (message.role !== 'tool') continue;
    const result = JSON.parse(message.content || '{}') as { quotes?: Quote[] };
    if (result.quotes?.length) return result.quotes[0];
  }
}

async function finishRun(value: Session) {
  await startRun(value);
  await vi.runAllTimersAsync();
  expect(hasActiveRun(value.id)).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('No mock response configured; network is disabled.'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Kiln runner with local mock responses', () => {
  it('completes four tool rounds, preserves tool-call linkage and records actual response usage', async () => {
    const requests: ModelRequest[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      expect(url).toBe('http://127.0.0.1:9999/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-placeholder' });
      const body = requestBody(init);
      requests.push(body);
      expect(body).toMatchObject({ model: 'qwen3-32b', tool_choice: 'auto', max_tokens: 4096, stream: false });
      expect(body.tools.every(tool => tool.function.description.length > 0)).toBe(true);
      const quote = returnedQuote(body);
      if (!quote) return toolResponse('get_quotes');
      const toolMessage = body.messages.at(-1)!;
      const assistantMessage = body.messages.at(-2)!;
      expect(toolMessage.tool_call_id).toBe(assistantMessage.tool_calls?.[0].id);
      return toolResponse('propose_purchase', { quoteId: quote.id });
    });
    const value = session();
    await finishRun(value);
    expect(value.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(value.records).toHaveLength(2);
    expect(value.records.map(record => record.quote.id)).toEqual([returnedQuote(requests[1])!.id, returnedQuote(requests[3])!.id]);
    expect(value.records[1].context.spentMicros).toBe(1_600_000);
    expect(value.records.every(record => record.status === 'simulated' && record.txHash === undefined)).toBe(true);
    expect(value.usage.map(entry => entry.flow)).toEqual(['invoice-1/call-1', 'invoice-1/call-2', 'invoice-2/call-3', 'invoice-2/call-4']);
    expect(value.usage.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0)).toBe(480);
    expect(value.events.filter(event => event.kind === 'model_response')).toHaveLength(4);
  });

  it('allows correction in each step, completing both at the eight-call total boundary', async () => {
    const stepCounts = new Map<number, number>();
    fetchMock.mockImplementation(async (_url, init) => {
      const body = requestBody(init);
      const step = (JSON.parse(body.messages[1].content!) as { step: number }).step;
      const count = (stepCounts.get(step) || 0) + 1;
      stepCounts.set(step, count);
      if (count <= 3) return toolResponse('get_quotes');
      return toolResponse('propose_purchase', { quoteId: returnedQuote(body)!.id });
    });
    const value = session();
    await finishRun(value);
    expect(value.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(value.records).toHaveLength(2);
    expect(value.events.filter(event => event.kind === 'model').at(-1)?.detail).toContain('本步骤调用 4/4，整次运行调用 8/8');
  });

  it.each([
    ['HTTP 401', () => new Response('', { status: 401 }), 'HTTP 401'],
    ['bad schema', () => Response.json({ choices: [] }), 'unsupported response schema'],
    ['truncation', () => toolResponse('get_quotes', {}, { truncated: true }), 'truncated at max_tokens=4096'],
  ])('stops on %s without executing tools or falling back to fixture', async (_name, response, expectedError) => {
    fetchMock.mockImplementation(async () => response());
    const value = session();
    await finishRun(value);
    expect(value.status).toBe('error');
    expect(value.error).toContain(expectedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(value.records).toEqual([]);
    expect(value.events.some(event => ['quote', 'proposal', 'simulated'].includes(event.kind))).toBe(false);
  });

  it('rejects invented quote IDs and stops after four calls in the first step without recording spending', async () => {
    fetchMock.mockImplementation(async (_url, init) => returnedQuote(requestBody(init))
      ? toolResponse('propose_purchase', { quoteId: randomUUID() })
      : toolResponse('get_quotes'));
    const value = session();
    await finishRun(value);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(value.status).toBe('error');
    expect(value.error).toContain('accounts-payable step 1: 4/4 calls in this step, 4/8 calls in this run');
    expect(value.records).toEqual([]);
    expect(value.events.some(event => event.kind === 'proposal')).toBe(false);
  });

  it('does not invent usage when a valid response omits it', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const quote = returnedQuote(requestBody(init));
      return quote ? toolResponse('propose_purchase', { quoteId: quote.id }, { usage: false })
        : toolResponse('get_quotes', {}, { usage: false });
    });
    const value = session();
    await finishRun(value);
    expect(value.status).toBe('completed');
    expect(value.usage).toEqual([]);
    expect(value.events.filter(event => event.kind === 'usage')).toHaveLength(4);
    expect(value.events.filter(event => event.kind === 'model_response')).toHaveLength(4);
  });

  it('aborts a pending model request and never records spending after stop', async () => {
    let requestSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const value = session();
    await startRun(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await stopRun(value);
    await vi.runAllTimersAsync();
    expect(requestSignal?.aborted).toBe(true);
    expect(value.status).toBe('stopped');
    expect(value.records).toEqual([]);
    expect(value.usage).toEqual([]);
    expect(hasActiveRun(value.id)).toBe(false);
  });
});
