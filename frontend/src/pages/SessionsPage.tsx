import React, { useState, useEffect, useCallback } from 'react';
import { Users, RefreshCw } from 'lucide-react';
import { api, type SessionRecord } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Pagination } from '../components/Pagination';

const PAGE_SIZES = [10, 20, 50, 100, 200];

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Session IDs are client-supplied verbatim (explicit session header wins) and
 * some clients send a whole JSON blob (e.g. {"device_id":"...","account_uuid":
 * "","session_id":"<uuid>"}). For display, extract the inner session_id when
 * parseable, otherwise truncate over-long ids; full value stays in the tooltip.
 */
const formatSessionId = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string' && parsed.session_id) {
      return parsed.session_id;
    }
  } catch {
    /* plain string id */
  }
  return raw.length <= 24 ? raw : `${raw.slice(0, 12)}…${raw.slice(-8)}`;
};

/** Tier display: show the tier's own name (Fast / Flagship / Reasoning), not opaque numbers. */
const TIER_LABEL: Record<SessionRecord['maxTier'], string> = {
  fast: 'usage.tierNameFast',
  flagship: 'usage.tierNameFlagship',
  reasoning: 'usage.tierNameReasoning',
};
const TIER_BADGE: Record<SessionRecord['maxTier'], string> = {
  fast: 'badge-success',
  flagship: 'badge-info',
  reasoning: 'badge-warning',
};

export const SessionsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getSessions(pageSize, (page - 1) * pageSize);
      setSessions(res.sessions);
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
          <Users size={18} color="var(--accent-violet)" />
          <span>{t('usage.sessionsTitle')}</span>
        </div>
        <button className="btn btn-sm" onClick={loadData} disabled={loading}>
          <RefreshCw size={12} />
          <span>{t('usage.refresh')}</span>
        </button>
      </div>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', margin: '0 0 12px 0' }}>
        {t('usage.sessionsDesc')}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--card-border)', color: 'var(--text-dim)' }}>
              <th style={{ padding: '10px 14px' }}>{t('usage.thSessionId')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thPinned')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thTier')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thTurns')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thRequests')}</th>
              <th style={{ padding: '10px 14px' }}>{t('usage.thActive')}</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length > 0 ? (
              sessions.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)' }}>
                    <span
                      title={s.id}
                      style={{ cursor: 'copy' }}
                      onClick={async () => {
                        const ok = await copyToClipboard(s.id);
                        if (ok) toast.success(t('usage.copiedSessionId'));
                        else toast.error(t('usage.copyFailed'));
                      }}
                    >
                      {formatSessionId(s.id)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.pinnedModel}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${TIER_BADGE[s.maxTier]}`}>{t(TIER_LABEL[s.maxTier])}</span>
                  </td>
                  <td style={{ padding: '10px 14px' }}>{s.turnCount}</td>
                  <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                    {s.traceCount.toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-dim)' }}>
                    {new Date(s.lastActiveAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>
                  {t('usage.emptySessions')}
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
