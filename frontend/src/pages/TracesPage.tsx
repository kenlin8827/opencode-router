import React, { useState, useEffect, useCallback } from 'react';
import { Activity, RefreshCw, Zap } from 'lucide-react';
import { api, type TraceRecord } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { Pagination } from '../components/Pagination';

const PAGE_SIZES = [10, 20, 50, 100, 200];

export const TracesPage: React.FC = () => {
  const { t } = useI18n();
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);

  // Auto-refresh re-fetches the CURRENT page without resetting it:
  // page 1 keeps live-tailing the newest records; page N > 1 browses a
  // stable history window (offset may shift slightly as new records arrive).
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTraces(pageSize, (page - 1) * pageSize);
      setTraces(res.traces);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Activity size={18} color="var(--accent)" />
          <span>{t('usage.tracesTitle')}</span>
        </div>
        <button className="btn btn-sm" onClick={loadData} disabled={loading}>
          <RefreshCw size={12} />
          <span>{t('usage.refresh')}</span>
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--card-border)', color: 'var(--text-dim)' }}>
              <th style={{ padding: '10px 14px' }}>{t('usage.thTraceId')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thTime')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thModel')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thCache')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thTokens')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thCostSaved')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thLatency')}</th>
            </tr>
          </thead>
          <tbody>
            {traces.length > 0 ? (
              traces.map(item => (
                <tr key={item.traceId} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)' }}>
                    {item.traceId.slice(0, 14)}...
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                    <span style={{ color: 'var(--text-dim)', marginRight: '6px' }}>[{item.execution.provider}]</span>
                    <span>{item.execution.modelUsed}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {item.finops.cachedPromptTokens > 0 ? (
                      <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Zap size={11} fill="currentColor" /> HIT
                      </span>
                    ) : (
                      <span className="badge" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-dim)' }}>
                        MISS
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                    {(item.finops.promptTokens + item.finops.completionTokens).toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--accent-emerald)', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
                    ${item.finops.savedCostUsd.toFixed(4)}
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                    {item.execution.latencyMs} ms
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>
                  {t('usage.emptyTraces')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '0 14px' }}>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onChange={setPage}
          disabled={loading}
          showSummary
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      </div>
    </div>
  );
};
