import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cpu, RefreshCw, Search, Brain, Wrench, Eye, AudioLines, Video, Thermometer, Pencil, Zap, Loader2 } from 'lucide-react';
import { opencodeApi, type OpenCodeModelView } from '../lib/api';
import { useModelTest } from '../lib/useModelTest';
import { useI18n } from '../i18n/I18nContext';
import { ModelEditDialog } from '../components/ModelEditDialog';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Switch } from '../components/Switch';

type SortKey = 'default' | 'priceAsc' | 'priceDesc' | 'contextDesc' | 'name';

const PAGE_SIZE = 50;
const PAGE_SIZES = [10, 20, 50, 100, 200];

/** 200000 → "200K", 1000000 → "1M" */
const SOURCE_BADGE: Record<string, { color: string; bg: string; labelKey: string }> = {
  builtin: { color: 'var(--accent)', bg: 'rgba(6,182,212,0.12)', labelKey: 'models.srcBuiltin' },
  openrouter: { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', labelKey: 'models.srcOpenrouter' },
  config: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', labelKey: 'models.srcConfig' },
  'openai-compatible': { color: 'var(--text-dim)', bg: 'rgba(255,255,255,0.06)', labelKey: 'models.srcOpenaiCompatible' },
  service: { color: 'var(--text-dim)', bg: 'rgba(255,255,255,0.06)', labelKey: 'models.srcService' },
};

const fmtContext = (n?: number): string => {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return `${Number.isInteger(n / 1_000_000) ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};

const fmtPrice = (v?: number): string =>
  typeof v === 'number' && v >= 0 ? `$${v.toFixed(2)}` : '—';

/** Any capability that renders a badge — decides whether the "—" placeholder shows. */
const hasCapability = (m: OpenCodeModelView): boolean =>
  Boolean(
    m.reasoning ||
      m.tool_call ||
      m.attachment ||
      m.temperature ||
      m.modalities?.input?.includes('image') ||
      m.modalities?.input?.includes('audio') ||
      m.modalities?.input?.includes('video')
  );

const badgeStyle = (color: string, bg: string): React.CSSProperties => ({
  background: bg,
  color,
  fontSize: '10px',
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: '99px',
  border: `1px solid ${bg}`,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
});

const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: '11px',
  fontWeight: 700,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid var(--card-border)',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '9px 14px',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  verticalAlign: 'top',
};

export const ModelsPage: React.FC = () => {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();

  const [models, setModels] = useState<OpenCodeModelView[]>([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<{ providerId: string; modelId: string } | null>(null);
  const { testingIds, testResults, testOne, isBusy } = useModelTest();

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState(searchParams.get('provider') || '');
  // Connected-only is a stable personal preference — remember it (first visit: unchecked).
  const [onlyConnected, setOnlyConnected] = useState(() => localStorage.getItem('ocr_models_only_connected') === '1');
  const [sort, setSort] = useState<SortKey>('default');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const load = async () => {
    setLoading(true);
    try {
      const res = await opencodeApi.listModels();
      setModels(res.models);
      setSource(res.source);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providerOptions = useMemo(() => {
    const map = new Map<string, { id: string; name?: string; connected: boolean; count: number }>();
    for (const m of models) {
      const e = map.get(m.providerId);
      if (e) e.count += 1;
      else map.set(m.providerId, { id: m.providerId, name: m.providerName, connected: m.connected, count: 1 });
    }
    return Array.from(map.values()).sort(
      (a, b) => Number(b.connected) - Number(a.connected) || (a.name || a.id).localeCompare(b.name || b.id)
    );
  }, [models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = models.filter((m) => {
      if (onlyConnected && !m.connected) return false;
      if (provider && m.providerId !== provider) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q) ||
        m.providerId.toLowerCase().includes(q) ||
        (m.providerName || '').toLowerCase().includes(q)
      );
    });
    const price = (m: OpenCodeModelView) =>
      typeof m.cost?.input === 'number' && m.cost.input >= 0 ? m.cost.input : Infinity;
    switch (sort) {
      case 'priceAsc':
        list = [...list].sort((a, b) => price(a) - price(b));
        break;
      case 'priceDesc':
        list = [...list].sort((a, b) => price(b) - price(a));
        break;
      case 'contextDesc':
        list = [...list].sort((a, b) => (b.limit?.context || 0) - (a.limit?.context || 0));
        break;
      case 'name':
        list = [...list].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        break;
    }
    return list;
  }, [models, query, provider, onlyConnected, sort]);

  const selectProvider = (id: string) => {
    setProvider(id);
    setPage(1);
    setSearchParams(id ? { provider: id } : {}, { replace: true });
  };

  const pagedModels = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Cpu size={18} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{t('models.title')}</span>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '0 0 16px' }}>
          {t('models.desc')}
          {source && <span> · {t('models.source', { source })}</span>}
        </p>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: 'var(--accent-rose)', fontSize: '13px', marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {/* ---- Toolbar ---- */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
            <input
              className="input"
              style={{ fontSize: 12, paddingLeft: 30, width: '100%' }}
              placeholder={t('models.search')}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            />
          </div>
          <Combobox
            style={{ fontSize: 12, width: 220, cursor: 'pointer' }}
            value={provider}
            onChange={selectProvider}
            clearable
            options={[
              { value: '', label: t('models.filterAll') },
              ...providerOptions.map((p) => ({
                value: p.id,
                label: p.name || p.id,
                meta: `(${p.count})${p.connected ? '' : ' ·'}`,
              })),
            ]}
          />
          <Combobox
            style={{ fontSize: 12, width: 'auto', cursor: 'pointer' }}
            value={sort}
            onChange={(v) => { setSort(v as SortKey); setPage(1); }}
            options={[
              { value: 'default', label: t('models.sortDefault') },
              { value: 'priceAsc', label: t('models.sortPriceAsc') },
              { value: 'priceDesc', label: t('models.sortPriceDesc') },
              { value: 'contextDesc', label: t('models.sortContextDesc') },
              { value: 'name', label: t('models.sortName') },
            ]}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            <Switch
              size="sm"
              checked={onlyConnected}
              onChange={(v) => { setOnlyConnected(v); localStorage.setItem('ocr_models_only_connected', v ? '1' : '0'); setPage(1); }}
            />
            {t('models.onlyConnected')}
          </label>
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('models.refresh')}</span>
          </button>
        </div>

        {/* ---- Table ---- */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('models.thModel')}</th>
                <th style={thStyle}>{t('models.thProvider')}</th>
                <th style={thStyle}>{t('models.thContext')}</th>
                <th style={thStyle}>{t('models.thInput')}</th>
                <th style={thStyle}>{t('models.thOutput')}</th>
                <th style={thStyle}>{t('models.thCapabilities')}</th>
                <th style={thStyle}>{t('models.thSource')}</th>
              </tr>
            </thead>
            <tbody>
              {pagedModels.map((m) => {
                const rowKey = `${m.providerId}/${m.id}`;
                const res = testResults[rowKey];
                return (
                <tr key={rowKey}>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, wordBreak: 'break-all' }}>{m.id}</span>
                      {res && (
                        <span
                          style={{
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 10,
                            whiteSpace: 'nowrap',
                            color: res.ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                          }}
                          title={res.ok ? `${res.latencyMs} ms` : res.error}
                        >
                          {res.ok ? `✓${res.latencyMs}ms` : '✗'}
                        </span>
                      )}
                      <button
                        className="btn btn-sm"
                        style={{ padding: '2px 5px', display: 'inline-flex', flexShrink: 0 }}
                        title={testingIds.has(rowKey) ? t('op.testing') : t('op.testBtn')}
                        disabled={isBusy}
                        onClick={() => testOne({ key: rowKey, providerId: m.providerId, modelId: m.id })}
                      >
                        {testingIds.has(rowKey) ? <Loader2 size={10} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={10} />}
                      </button>
                      {m.custom && (
                        <button
                          title={t('op.pmEdit')}
                          onClick={() => setEditTarget({ providerId: m.providerId, modelId: m.id })}
                          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', flexShrink: 0 }}
                        >
                          <Pencil size={11} />
                        </button>
                      )}
                    </div>
                    {m.name && m.name !== m.id && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>{m.name}</div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {m.providerId}
                    {!m.connected && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-dim)' }} title={t('models.notConnected')}>○</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{fmtContext(m.limit?.context)}</td>
                  <td style={{ ...tdStyle, fontFamily: 'JetBrains Mono, monospace', color: m.cost?.input !== undefined && m.cost.input < 1 ? 'var(--accent-emerald)' : undefined, whiteSpace: 'nowrap' }}>
                    {fmtPrice(m.cost?.input)}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{fmtPrice(m.cost?.output)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {m.reasoning && <span style={badgeStyle('#a78bfa', 'rgba(167,139,250,0.12)')}><Brain size={10} />{t('models.badgeReasoning')}</span>}
                      {m.tool_call && <span style={badgeStyle('var(--accent)', 'rgba(6,182,212,0.12)')}><Wrench size={10} />{t('models.badgeToolCall')}</span>}
                      {(m.attachment || m.modalities?.input?.includes('image')) && <span style={badgeStyle('#34d399', 'rgba(52,211,153,0.12)')}><Eye size={10} />{t('models.badgeVision')}</span>}
                      {m.modalities?.input?.includes('audio') && <span style={badgeStyle('#f472b6', 'rgba(244,114,182,0.12)')}><AudioLines size={10} />{t('models.badgeAudio')}</span>}
                      {m.modalities?.input?.includes('video') && <span style={badgeStyle('#60a5fa', 'rgba(96,165,250,0.12)')}><Video size={10} />{t('models.badgeVideo')}</span>}
                      {m.temperature && <span style={badgeStyle('#fb923c', 'rgba(251,146,60,0.12)')}><Thermometer size={10} />{t('models.badgeTemperature')}</span>}
                      {!hasCapability(m) && <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(SOURCE_BADGE[m.source]?.color ?? 'var(--text-dim)', SOURCE_BADGE[m.source]?.bg ?? 'rgba(255,255,255,0.06)')}>
                      {t(SOURCE_BADGE[m.source]?.labelKey ?? 'models.srcBuiltin')}
                    </span>
                  </td>
                </tr>
                );
              })}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)' }}>
                    {t('models.empty')}
                    {models.length > 0 && <div style={{ marginTop: 6, fontSize: 11 }}>{t('models.emptyFiltered')}</div>}
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)' }}>
                    {t('common.loading')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ---- Footer: pagination (summary left, controls right, one row) ---- */}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onChange={setPage}
          showSummary
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />

        {editTarget && (
          <ModelEditDialog
            providerId={editTarget.providerId}
            modelId={editTarget.modelId}
            onClose={() => setEditTarget(null)}
            onSaved={load}
          />
        )}
      </div>
    </div>
  );
};
