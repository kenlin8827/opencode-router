import React, { useState, useEffect, useCallback } from 'react';
import { Database, RefreshCw, Zap, Coins, PiggyBank, Activity, GitBranch } from 'lucide-react';
import { api, type CacheStatsResponse } from '../lib/api';

// Sticky column header inside the scrollable per-model table.
const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  position: 'sticky',
  top: 0,
  background: 'var(--card-bg)',
  zIndex: 1,
};
import { useI18n } from '../i18n/I18nContext';

const REFRESH_INTERVAL_MS = 10_000;

export const CachePage: React.FC = () => {
  const { t } = useI18n();
  const [data, setData] = useState<CacheStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getCacheStats());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadData]);

  const stats = data?.stats;
  const totalRequests = stats?.totalRequests || 0;
  const cachedRequests = stats?.cachedRequests || 0;
  const requestHitPct = ((stats?.requestHitRatio || 0) * 100).toFixed(1);
  const promptTokens = stats?.promptTokens || 0;
  const cachedTokens = stats?.cachedPromptTokens || 0;
  const tokenHitPct = ((stats?.tokenHitRatio || 0) * 100).toFixed(1);
  const savedCost = stats?.savedCostUsd || 0;
  const models = stats?.models || [];
  const hourly = stats?.hourly || [];
  const routingCache = data?.routingCache;

  const maxHourlyTokens = Math.max(1, ...hourly.map(h => h.promptTokens));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
      {/* Header */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Database size={18} color="var(--accent)" />
            <span>{t('cachePage.title')}</span>
          </div>
          <button className="btn btn-sm" onClick={loadData} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('cachePage.refresh')}</span>
          </button>
        </div>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
          {t('cachePage.desc', { count: stats?.windowTraces || 0 })}
        </p>

        {/* 4 stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', marginTop: '16px' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '10px', padding: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span>{t('cachePage.requestHit')}</span>
              <Activity size={14} color="var(--accent)" />
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, margin: '6px 0 2px 0', color: 'var(--accent)' }}>
              {requestHitPct}%
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
              {t('cachePage.requestHitSub', { cached: cachedRequests.toLocaleString(), total: totalRequests.toLocaleString() })}
            </div>
          </div>

          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '10px', padding: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span>{t('cachePage.tokenHit')}</span>
              <Zap size={14} color="var(--accent-emerald)" />
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, margin: '6px 0 2px 0', color: 'var(--accent-emerald)' }}>
              {tokenHitPct}%
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
              {t('cachePage.tokenHitSub', { cached: cachedTokens.toLocaleString(), total: promptTokens.toLocaleString() })}
            </div>
          </div>

          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '10px', padding: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span>{t('cachePage.cachedTokens')}</span>
              <Coins size={14} color="var(--accent-violet)" />
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, margin: '6px 0 2px 0' }}>
              {cachedTokens.toLocaleString()}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              {t('cachePage.cachedTokensSub')}
            </div>
          </div>

          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '10px', padding: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span>{t('cachePage.savedCost')}</span>
              <PiggyBank size={14} color="var(--accent-amber)" />
            </div>
            <div style={{ fontSize: '24px', fontWeight: 800, margin: '6px 0 2px 0', color: 'var(--accent-amber)' }}>
              ${savedCost.toFixed(4)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              {t('cachePage.savedCostSub')}
            </div>
          </div>

          {routingCache?.enabled && (
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
                <span>{t('cachePage.routingCache')}</span>
                <GitBranch size={14} color="var(--accent)" />
              </div>
              <div style={{ fontSize: '24px', fontWeight: 800, margin: '6px 0 2px 0' }}>
                {((routingCache.hitRatio || 0) * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                {t('cachePage.routingCacheSub', { hits: routingCache.hits || 0, total: (routingCache.hits || 0) + (routingCache.misses || 0), entries: routingCache.entries || 0, max: routingCache.maxEntries || 0 })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 24h hourly series */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Activity size={16} color="var(--accent-emerald)" />
            <span>{t('cachePage.hourlyTitle')}</span>
          </div>
        </div>
        {hourly.length > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '120px', padding: '0 4px' }}>
              {hourly.map(h => {
                const cachedH = Math.round((h.cachedPromptTokens / maxHourlyTokens) * 100);
                const totalH = Math.max(cachedH, Math.round((h.promptTokens / maxHourlyTokens) * 100));
                const hourLabel = new Date(h.hourTs).toLocaleTimeString([], { hour: '2-digit' });
                return (
                  <div
                    key={h.hourTs}
                    title={t('cachePage.hourlyBarTip', {
                      hour: hourLabel,
                      cached: h.cachedPromptTokens.toLocaleString(),
                      total: h.promptTokens.toLocaleString(),
                      requests: h.requests,
                    })}
                    style={{
                      flex: 1,
                      height: `${totalH}%`,
                      minHeight: totalH > 0 ? '3px' : '1px',
                      background: 'var(--btn-bg-hover)',
                      borderRadius: '3px 3px 0 0',
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ height: `${cachedH}%`, background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-dim)', padding: '6px 4px 0 4px' }}>
              <span>{t('cachePage.hourlyAgo')}</span>
              <span>{t('cachePage.hourlyNow')}</span>
            </div>
            <div style={{ display: 'flex', gap: '16px', marginTop: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '10px', height: '10px', background: 'var(--accent)', borderRadius: '2px', display: 'inline-block' }} />
                {t('cachePage.legendCached')}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '10px', height: '10px', background: 'var(--btn-bg-hover)', border: '1px solid var(--card-border)', borderRadius: '2px', display: 'inline-block' }} />
                {t('cachePage.legendTotal')}
              </span>
            </div>
          </>
        ) : (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
            {t('cachePage.empty')}
          </div>
        )}
      </div>

      {/* Per-model breakdown */}
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="card-header">
          <div className="card-title">
            <Database size={16} color="var(--accent-violet)" />
            <span>{t('cachePage.modelsTitle')}</span>
          </div>
        </div>
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--card-border)', color: 'var(--text-dim)' }}>
                <th style={TH_STYLE}>{t('cachePage.thModel')}</th>
                <th style={TH_STYLE}>{t('cachePage.thRequests')}</th>
                <th style={TH_STYLE}>{t('cachePage.thHitRate')}</th>
                <th style={TH_STYLE}>{t('cachePage.thPromptTokens')}</th>
                <th style={TH_STYLE}>{t('cachePage.thCachedTokens')}</th>
                <th style={TH_STYLE}>{t('cachePage.thSavedCost')}</th>
              </tr>
            </thead>
            <tbody>
              {models.length > 0 ? (
                models.map(m => {
                  const rowPct = m.promptTokens > 0 ? ((m.cachedPromptTokens / m.promptTokens) * 100).toFixed(1) : '0.0';
                  return (
                    <tr key={`${m.provider}::${m.model}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                        <span style={{ color: 'var(--text-dim)', marginRight: '6px' }}>[{m.provider}]</span>
                        <span>{m.model}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                        {m.requests.toLocaleString()}
                        {m.cachedRequests > 0 && (
                          <span style={{ color: 'var(--accent-emerald)', marginLeft: '6px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                            <Zap size={11} fill="currentColor" /> {m.cachedRequests}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)', fontWeight: 700 }}>
                        {rowPct}%
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace' }}>
                        {m.promptTokens.toLocaleString()}
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent-emerald)' }}>
                        {m.cachedPromptTokens.toLocaleString()}
                      </td>
                      <td style={{ padding: '10px 14px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent-amber)' }}>
                        ${m.savedCostUsd.toFixed(4)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>
                    {t('cachePage.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
