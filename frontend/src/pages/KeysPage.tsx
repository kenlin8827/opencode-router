import React, { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Key, Check, RefreshCw, Trash2, Plug, Plus, Lock, Cpu, Eye, Zap } from 'lucide-react';
import { opencodeApi, type OpenCodeProviderView, type OpenCodeCatalogProvider } from '../lib/api';
import { ProviderModelsDialog } from '../components/ProviderModelsDialog';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';
import { Switch } from '../components/Switch';
import { useModelTest } from '../lib/useModelTest';

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid var(--card-border)',
  borderRadius: '10px',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const CATALOG_PAGE_SIZE = 20;
const CONNECTED_PAGE_SIZE = 12;
const CONNECTED_PAGE_SIZES = [12, 24, 48];
const CATALOG_PAGE_SIZES = [10, 20, 50, 100, 200];

/** Fallback npm packages when the models.dev catalog is unavailable. */
const FALLBACK_NPM_PACKAGES = [
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/azure',
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/xai',
  '@ai-sdk/mistral',
];
const CUSTOM_NPM = '__custom__';

/** Provider logo on a light chip (models.dev SVGs are dark glyphs — invisible on
 *  the dark theme without a backing plate). Falls back to an initial-letter chip. */
const ProviderLogo: React.FC<{ id: string; logo?: string; size?: number }> = ({ id, logo, size = 28 }) => {
  const [failed, setFailed] = useState(false);
  const chip: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, size * 0.28),
    background: 'rgba(244, 244, 245, 0.95)',
    border: '1px solid var(--card-border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  };
  if (!logo || failed) {
    return (
      <div style={chip}>
        <span
          style={{
            fontWeight: 800,
            fontSize: size * 0.52,
            color: '#18181b',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}
        >
          {id.slice(0, 1)}
        </span>
      </div>
    );
  }
  return (
    <div style={chip}>
      <img
        src={logo}
        alt={id}
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        onError={() => setFailed(true)}
        style={{ objectFit: 'contain' }}
        loading="lazy"
      />
    </div>
  );
};

const badgeStyle = (color: string, bg: string): React.CSSProperties => ({
  background: bg,
  color,
  fontSize: '10px',
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: '99px',
  border: `1px solid ${bg}`,
});

export const KeysPage: React.FC = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [ocProviders, setOcProviders] = useState<OpenCodeProviderView[]>([]);
  const [ocPaths, setOcPaths] = useState<{ configPath: string; authPath: string }>({ configPath: '', authPath: '' });
  const [catalog, setCatalog] = useState<OpenCodeCatalogProvider[]>([]);
  const [catalogSource, setCatalogSource] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectKey, setConnectKey] = useState('');
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyEditValue, setKeyEditValue] = useState('');
  const [modelsPanelId, setModelsPanelId] = useState<string | null>(null);
  const { testingIds, testResults, testAll, testOne, testAllTargets } = useModelTest();
  const [notice, setNotice] = useState('');
  const [ocError, setOcError] = useState('');
  const [busy, setBusy] = useState(false);

  // Custom provider create form
  const [form, setForm] = useState({ id: '', name: '', baseURL: '', npm: '', apiKey: '', inline: false });
  const [npmChoice, setNpmChoice] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'connected' | 'catalog' | 'custom'>('connected');
  const [hideConnected, setHideConnected] = useState(true);
  const [connectedQuery, setConnectedQuery] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogPageSize, setCatalogPageSize] = useState(CATALOG_PAGE_SIZE);
  const [connectedPage, setConnectedPage] = useState(1);
  const [connectedPageSize, setConnectedPageSize] = useState(CONNECTED_PAGE_SIZE);

  // npm dropdown options: aggregate from models.dev catalog (usage-sorted),
  // always led by the openai-compatible default; offline → curated fallback.
  const npmOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of catalog) {
      if (!c.npm) continue;
      counts.set(c.npm, (counts.get(c.npm) || 0) + 1);
    }
    const fromCatalog = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([pkg]) => pkg);
    const merged = ['@ai-sdk/openai-compatible', ...fromCatalog.filter((p) => p !== '@ai-sdk/openai-compatible')];
    return merged.length > 1 ? merged : FALLBACK_NPM_PACKAGES;
  }, [catalog]);

  const connectedIds = useMemo(() => new Set(ocProviders.map((p) => p.id)), [ocProviders]);
  const connectedResults = useMemo(() => {
    const q = connectedQuery.trim().toLowerCase();
    if (!q) return ocProviders;
    return ocProviders.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        (p.name || '').toLowerCase().includes(q) ||
        (p.baseURL || '').toLowerCase().includes(q) ||
        p.models.some((m) => m.toLowerCase().includes(q))
    );
  }, [ocProviders, connectedQuery]);
  const pagedConnected = useMemo(() => {
    const start = (connectedPage - 1) * connectedPageSize;
    return connectedResults.slice(start, start + connectedPageSize);
  }, [connectedResults, connectedPage, connectedPageSize]);

  const catalogResults = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    let list = q
      ? catalog.filter((c) => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
      : catalog;
    if (hideConnected) list = list.filter((c) => !connectedIds.has(c.id));
    return list;
  }, [catalog, catalogQuery, hideConnected, connectedIds]);

  const pagedCatalog = catalogResults.slice(
    (catalogPage - 1) * catalogPageSize,
    catalogPage * catalogPageSize
  );

  const tabBtn = (tab: typeof activeTab, label: string, count?: number): React.CSSProperties => ({
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: '12.5px',
    fontWeight: activeTab === tab ? 700 : 500,
    color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
    background: activeTab === tab ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
    border: activeTab === tab ? '1px solid var(--card-border)' : '1px solid transparent',
    cursor: 'pointer',
  });

  const loadOpenCodeProviders = async () => {
    try {
      const res = await opencodeApi.listProviders();
      setOcProviders(res.providers);
      setOcPaths({ configPath: res.configPath, authPath: res.authPath });
      setOcError('');
    } catch (err: any) {
      setOcError(err.message);
    }
  };

  const loadCatalog = async (refresh = false) => {
    try {
      const res = await opencodeApi.catalog(refresh);
      setCatalog(res.providers);
      setCatalogSource(res.source);
    } catch {
      setCatalog([]);
      setCatalogSource('none');
    }
  };

  useEffect(() => {
    loadOpenCodeProviders();
    loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link from /models: /providers?openModels=<id> opens the maintenance
  // dialog for that config-defined provider once the list has loaded.
  useEffect(() => {
    const target = searchParams.get('openModels');
    if (!target || ocProviders.length === 0) return;
    const p = ocProviders.find((x) => x.id === target);
    if (p?.custom) setModelsPanelId(target);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocProviders, searchParams]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 4000);
  };

  const handleConnect = async (id: string) => {
    if (!connectKey.trim()) return;
    setBusy(true);
    try {
      await opencodeApi.connectProvider(id, connectKey.trim());
      showNotice(t('op.connectOk'));
      setConnectingId(null);
      setConnectKey('');
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateKey = async (id: string) => {
    if (!keyEditValue.trim()) return;
    setBusy(true);
    try {
      await opencodeApi.connectProvider(id, keyEditValue.trim());
      showNotice(t('op.keyUpdated'));
      setKeyEditId(null);
      setKeyEditValue('');
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Batch test: bounded concurrency over the currently visible connected providers. */
  const handleTestAllProviders = () =>
    testAllTargets(connectedResults.map((p) => ({ key: p.id, providerId: p.id })));

  const handleDelete = async (p: OpenCodeProviderView) => {
    const ok = await confirmDialog({
      title: t('op.deleteConfirm', { id: p.id }),
      description: t('op.deletePurge'),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await opencodeApi.deleteProvider(p.id, true);
      showNotice(t('op.deleted'));
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCustom = async () => {
    if (!form.id.trim() || !form.baseURL.trim()) {
      toast.error(t('op.idAndUrlRequired'));
      return;
    }
    setBusy(true);
    try {
      await opencodeApi.createProvider({
        id: form.id.trim(),
        name: form.name.trim() || undefined,
        baseURL: form.baseURL.trim(),
        npm: form.npm.trim() || undefined,
        apiKey: form.apiKey.trim() || undefined,
        apiKeyInline: form.inline,
      });
      showNotice(t('op.customTitle') + ' ✓');
      setForm({ id: '', name: '', baseURL: '', npm: '', apiKey: '', inline: false });
      setNpmChoice('');
      await loadOpenCodeProviders();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const formatExpiry = (ms: number) => {
    const d = new Date(ms);
    const expired = d.getTime() < Date.now();
    return expired ? t('op.oauthExpired') : t('op.oauthExpires', { date: d.toLocaleDateString() });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'}}>
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Plug size={18} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{t('op.title')}</span>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '0 0 16px' }}>{t('op.desc')}</p>

        {notice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{notice}</span>
          </div>
        )}
        {ocError && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: 'var(--accent-rose)', fontSize: '13px', marginBottom: '16px' }}>
            {ocError}
          </div>
        )}

        {/* ---- Tabs ---- */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button style={tabBtn('connected', t('op.tabConnected'))} onClick={() => setActiveTab('connected')}>
            {t('op.tabConnected')} ({ocProviders.length})
          </button>
          <button style={tabBtn('catalog', t('op.tabCatalog'))} onClick={() => setActiveTab('catalog')}>
            {t('op.tabCatalog')} ({catalogResults.length})
          </button>
          <button style={tabBtn('custom', t('op.tabCustom'))} onClick={() => setActiveTab('custom')}>
            {t('op.tabCustom')}
          </button>
        </div>

        {/* Scrollable tab content: the tab bars stay fixed, long lists scroll here. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'connected' && (<>
        {/* ---- Connected providers (opencode.jsonc provider node ∪ auth.json) ---- */}
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('op.connectedTitle')}</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }} title={`${ocPaths.configPath} | ${ocPaths.authPath}`}>
          {t('op.connectedDesc')}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ fontSize: 12, maxWidth: 420, flex: 1, minWidth: 200 }}
            placeholder={t('op.searchConnected')}
            value={connectedQuery}
            onChange={e => { setConnectedQuery(e.target.value); setConnectedPage(1); }}
          />
          <button
            className="btn btn-sm"
            disabled={testAll.running || testingIds.size > 0 || connectedResults.length === 0}
            title={t('op.testAllBtn')}
            onClick={handleTestAllProviders}
          >
            {testAll.running ? <RefreshCw size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={12} />}
            <span>{testAll.running ? t('op.testAllRunning', { done: testAll.done, n: testAll.total }) : t('op.testAllBtn')}</span>
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
          {pagedConnected.map(p => (
            <div key={p.id} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ProviderLogo id={p.id} logo={p.logo} size={44} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, fontFamily: 'JetBrains Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.id}</span>
                  {p.name && <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {p.custom && <span style={badgeStyle('var(--accent)', 'rgba(6,182,212,0.15)')}>{t('op.badgeCustom')}</span>}
                  {p.auth.inline && (
                    <span style={{ ...badgeStyle('#f59e0b', 'rgba(245,158,11,0.12)'), display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Key size={9} />
                      {t('op.badgeInline')}
                    </span>
                  )}
                  {p.auth.type === 'oauth' && <span style={badgeStyle('#a78bfa', 'rgba(167,139,250,0.12)')}>{t('op.badgeOauth')}</span>}
                  {p.auth.type === 'api' && !p.auth.inline && (
                    <span style={badgeStyle('var(--text-dim)', 'rgba(255,255,255,0.06)')}>{t('op.badgeAuth')}</span>
                  )}
                </div>
                {keyEditId !== p.id && (
                  <button
                    className="btn btn-sm"
                    style={{ color: 'var(--accent-rose)', flexShrink: 0 }}
                    disabled={busy || testingIds.size > 0 || testAll.running}
                    title={t('op.deleteBtn')}
                    onClick={() => handleDelete(p)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              {p.baseURL && (
                <div style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                  {p.baseURL}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                <Lock size={11} />
                <span>{p.auth.keyMasked || '—'}</span>
                {p.auth.type === 'oauth' && p.auth.expires && (
                  <span style={{ color: p.auth.expires < Date.now() ? 'var(--accent-rose)' : 'var(--text-dim)' }}>
                    · {formatExpiry(p.auth.expires)}
                  </span>
                )}
              </div>

              {testResults[p.id] && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: 'JetBrains Mono, monospace',
                    color: testResults[p.id].ok ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                    wordBreak: 'break-all',
                  }}
                  title={testResults[p.id].ok ? undefined : testResults[p.id].error}
                >
                  {testResults[p.id].ok
                    ? `✓ ${testResults[p.id].model} · ${testResults[p.id].latencyMs} ms`
                    : `✗ ${testResults[p.id].error?.slice(0, 120) || t('op.testFailMsg')}`}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {keyEditId === p.id ? (
                  <>
                    <input
                      className="input"
                      style={{ fontSize: 12, flex: 1, minWidth: 140 }}
                      placeholder={t('op.updateKeyPrompt')}
                      value={keyEditValue}
                      onChange={e => setKeyEditValue(e.target.value)}
                      autoFocus
                    />
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => handleUpdateKey(p.id)}>
                      <Check size={12} />
                    </button>
                    <button className="btn btn-sm" onClick={() => { setKeyEditId(null); setKeyEditValue(''); }}>
                      ✕
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" onClick={() => setKeyEditId(p.id)}>
                    <Key size={12} />
                    <span>{t('op.updateKey')}</span>
                  </button>
                )}
                {keyEditId !== p.id && (
                  <>
                    <Link
                      className="btn btn-sm"
                      to={`/models?provider=${encodeURIComponent(p.id)}`}
                      title={t('op.viewAllModels')}
                      style={{ textDecoration: 'none' }}
                    >
                      <Eye size={12} />
                      <span>{t('op.viewBtn')}</span>
                    </Link>
                    <button
                      className="btn btn-sm"
                      disabled={testingIds.size > 0 || testAll.running}
                      title={testingIds.has(p.id) ? t('op.testing') : t('op.testBtn')}
                      onClick={() => testOne({ key: p.id, providerId: p.id })}
                    >
                      {testingIds.has(p.id) ? <RefreshCw size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} /> : <Zap size={12} />}
                      {!testingIds.has(p.id) && <span>{t('op.testBtn')}</span>}
                    </button>
                    <button
                      className="btn btn-sm"
                      style={modelsPanelId === p.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                      disabled={busy}
                      title={t('op.pmManage')}
                      onClick={() => setModelsPanelId(p.id)}
                    >
                      <Cpu size={12} />
                      <span>{t('op.pmManage')}</span>
                    </button>
                  </>
                )}
              </div>

              {modelsPanelId === p.id && (
                <ProviderModelsDialog
                  providerId={p.id}
                  providerName={p.name}
                  readOnly={!p.custom}
                  onClose={() => setModelsPanelId(null)}
                  onChanged={loadOpenCodeProviders}
                />
              )}
            </div>
          ))}
          {connectedResults.length === 0 && !ocError && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('op.emptyConnected')}</div>
          )}
        </div>

        </>)}

        {activeTab === 'catalog' && (<>
        {/* ---- Connect catalog provider ---- */}
        <div style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>{t('op.connectTitle')}</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }}>
          {t('op.connectDesc')} · {t('op.catalogSource', { source: catalogSource || 'none' })}
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            style={{ fontSize: 12, flex: 1 }}
            placeholder={t('op.searchCatalog')}
            value={catalogQuery}
            onChange={e => { setCatalogQuery(e.target.value); setCatalogPage(1); }}
          />
          <button className="btn btn-sm" onClick={() => loadCatalog(true)}>
            <RefreshCw size={12} />
            <span>{t('op.refreshCatalog')}</span>
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            <Switch size="sm" checked={hideConnected} onChange={v => { setHideConnected(v); setCatalogPage(1); }} />
            {t('op.hideConnected')}
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '10px' }}>
          {pagedCatalog.map(c => {
            const connected = connectedIds.has(c.id);
            return (
              <div key={c.id} style={{ ...cardStyle, padding: 12, opacity: connected ? 0.55 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <ProviderLogo id={c.id} logo={c.logo} size={38} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)' }}>
                  <span>{t('op.modelsCount', { n: c.modelCount })}</span>
                  {typeof c.priceFrom === 'number' && (
                    <span style={{ color: 'var(--accent-emerald)' }}>{t('op.priceFrom', { price: c.priceFrom })}</span>
                  )}
                </div>
                {connectingId === c.id ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      style={{ fontSize: 12, flex: 1 }}
                      placeholder={t('op.apiKeyPlaceholder')}
                      value={connectKey}
                      onChange={e => setConnectKey(e.target.value)}
                      autoFocus
                      onKeyDown={e => e.key === 'Enter' && handleConnect(c.id)}
                    />
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => handleConnect(c.id)}>
                      <Check size={12} />
                    </button>
                    <button className="btn btn-sm" onClick={() => { setConnectingId(null); setConnectKey(''); }}>✕</button>
                  </div>
                ) : (
                  <button
                    className="btn btn-sm"
                    disabled={connected}
                    onClick={() => { setConnectingId(c.id); setConnectKey(''); }}
                  >
                    <Plug size={12} />
                    <span>{connected ? '✓' : t('op.connectBtn')}</span>
                  </button>
                )}
              </div>
            );
          })}
          {catalog.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('op.catalogEmpty')}</div>
          )}
        </div>

        </>)}

        {activeTab === 'custom' && (<>
        {/* ---- Custom provider form ---- */}
        <div style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>{t('op.customTitle')}</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0 0 12px' }}>{t('op.customDesc')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(max(240px, 31%), 1fr))', gap: 10 }}>
          <input className="input" style={{ fontSize: 12 }} placeholder={t('op.fId')} value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
          <input className="input" style={{ fontSize: 12 }} placeholder={t('op.fName')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input className="input" style={{ fontSize: 12 }} placeholder={t('op.fBaseUrl')} value={form.baseURL} onChange={e => setForm({ ...form, baseURL: e.target.value })} />
          {npmChoice === CUSTOM_NPM ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" style={{ fontSize: 12, flex: 1 }} placeholder={t('op.fNpmCustom')} value={form.npm} onChange={e => setForm({ ...form, npm: e.target.value })} autoFocus />
              <button className="btn btn-sm" title={t('op.fNpm')} onClick={() => { setNpmChoice(''); setForm({ ...form, npm: '' }); }}>↩</button>
            </div>
          ) : (
            <Combobox
              style={{ fontSize: 12, cursor: 'pointer' }}
              value={npmChoice}
              onChange={(v) => {
                setNpmChoice(v);
                if (v === CUSTOM_NPM) setForm({ ...form, npm: '' });
                else setForm({ ...form, npm: v });
              }}
              placeholder={t('op.fNpm')}
              clearable
              options={[
                { value: '', label: t('op.fNpm') },
                ...npmOptions.map((pkg) => ({ value: pkg, label: pkg })),
                { value: CUSTOM_NPM, label: `${t('op.fNpmCustom')}…` },
              ]}
            />
          )}
          <input className="input" style={{ fontSize: 12 }} placeholder={t('op.fKey')} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)', margin: '10px 0' }}>
          <Switch size="sm" checked={form.inline} onChange={v => setForm({ ...form, inline: v })} />
          {t('op.fKeyInline')}
        </label>
        <div>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleCreateCustom}>
            <Plus size={12} />
            <span>{busy ? t('op.creating') : t('op.createBtn')}</span>
          </button>
        </div>
        </>)}
        </div>

        {/* Tab-scoped pagination pinned below the scroll area (never scrolls away). */}
        {activeTab === 'connected' && connectedResults.length > 0 && (
          <Pagination
            page={connectedPage}
            pageSize={connectedPageSize}
            total={connectedResults.length}
            onChange={setConnectedPage}
            showSummary
            pageSizeOptions={CONNECTED_PAGE_SIZES}
            onPageSizeChange={(s) => { setConnectedPageSize(s); setConnectedPage(1); }}
          />
        )}
        {activeTab === 'catalog' && catalogResults.length > 0 && (
          <Pagination
            page={catalogPage}
            pageSize={catalogPageSize}
            total={catalogResults.length}
            onChange={setCatalogPage}
            showSummary
            pageSizeOptions={CATALOG_PAGE_SIZES}
            onPageSizeChange={(s) => { setCatalogPageSize(s); setCatalogPage(1); }}
          />
        )}
      </div>
    </div>
  );
};
