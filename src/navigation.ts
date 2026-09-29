export const dashboardTabs = ['workspace', 'release', 'replay', 'evidence', 'settings'] as const;
export type DashboardTab = typeof dashboardTabs[number];

export function dashboardTabFromHash(hash: string): DashboardTab {
  const value = hash.replace(/^#/, '');
  return dashboardTabs.includes(value as DashboardTab) ? value as DashboardTab : 'workspace';
}

export type ReceiptRoute =
  | { kind: 'dashboard' }
  | { kind: 'receipt'; id: string; expectedDigest?: string }
  | { kind: 'invalid'; message: string };

/** Validate query parameters before they can become a local API path. */
export function receiptRouteFromSearch(search: string): ReceiptRoute {
  const params = new URLSearchParams(search);
  if (!params.has('receipt') && !params.has('digest')) return { kind: 'dashboard' };
  if (params.getAll('receipt').length !== 1 || params.getAll('digest').length > 1
    || [...params.keys()].some(key => key !== 'receipt' && key !== 'digest')) {
    return { kind: 'invalid', message: '收据链接参数不完整或重复，请使用“复制只读链接”生成的地址。' };
  }
  const id = params.get('receipt') || '';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    return { kind: 'invalid', message: '收据链接中的运行编号无效。' };
  }
  const digest = params.get('digest');
  if (digest !== null && !/^[a-f0-9]{64}$/.test(digest)) {
    return { kind: 'invalid', message: '收据链接中的摘要格式无效。' };
  }
  return { kind: 'receipt', id, ...(digest === null ? {} : { expectedDigest: digest }) };
}
