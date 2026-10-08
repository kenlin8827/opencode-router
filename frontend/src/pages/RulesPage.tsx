import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Zap, Scale, Brain, Save, RefreshCw, Plus, X, RotateCcw, Eye, Ban, Search } from 'lucide-react';
import { api, opencodeApi, type TierPoolInfo } from '../lib/api';
import { DEFAULT_TIER_MATCH } from '../lib/tierMatch';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

type Tier = 'fast' | 'flagship' | 'reasoning';

interface WeightRow {
  pattern: string;
  weight: string;
}

type FilterMode = 'none' | 'blacklist' | 'whitelist';
type SelectionStrategy = 'priority' | 'weighted' | 'round_robin';

interface TierPolicyForm {
  matchPatterns: string; // textarea, one wildcard pattern per line ('' = built-in default)
  matchMinInputPerM: string;
  matchMaxInputPerM: string;
  filterMode: FilterMode;
  filterPatterns: string; // textarea, one wildcard pattern per line
  selection: SelectionStrategy;
  weights: WeightRow[];
}

const TIERS: { key: Tier; labelKey: string; icon: typeof Zap; color: string }[] = [
  { key: 'fast', labelKey: 'tierPolicy.tierFast', icon: Zap, color: 'var(--accent-emerald)' },
  { key: 'flagship', labelKey: 'tierPolicy.tierFlagship', icon: Scale, color: 'var(--accent)' },
  { key: 'reasoning', labelKey: 'tierPolicy.tierReasoning', icon: Brain, color: 'var(--accent-violet)' },
];

const splitPatterns = (s: string): string[] =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

const parseNum = (s: string): number | undefined => {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

// The match inputs come PRE-FILLED with the built-in baseline (editable as-is);
// clearing a field and saving omits it → backend falls back to the baseline
// (providers/tier-match.ts). Note: saving persists the shown values explicitly.
const dmMatchFields = (tier: Tier) => {
  const dm = DEFAULT_TIER_MATCH[tier];
  return {
    matchPatterns: (dm.patterns || []).join('\n'),
    matchMinInputPerM: dm.minInputPerM != null ? String(dm.minInputPerM) : '',
    matchMaxInputPerM: dm.maxInputPerM != null ? String(dm.maxInputPerM) : '',
  };
};

const defaultFormFor = (tier: Tier): TierPolicyForm => ({
  ...dmMatchFields(tier),
  filterMode: 'none',
  filterPatterns: '',
  selection: 'priority',
  weights: [],
});

const formFromPolicy = (tier: Tier, p: any): TierPolicyForm => {
  const dm = dmMatchFields(tier);
  // Per-field: a saved value wins; an absent field shows the built-in baseline.
  const withDefaults = {
    matchPatterns: p?.match?.patterns != null ? p.match.patterns.join('\n') : dm.matchPatterns,
    matchMinInputPerM: p?.match?.minInputPerM != null ? String(p.match.minInputPerM) : dm.matchMinInputPerM,
    matchMaxInputPerM: p?.match?.maxInputPerM != null ? String(p.match.maxInputPerM) : dm.matchMaxInputPerM,
  };
  if (!p || Object.keys(p).length === 0) return { ...defaultFormFor(tier), ...withDefaults };
  return {
    ...withDefaults,
    filterMode: p?.blacklist?.length ? 'blacklist' : p?.whitelist?.length ? 'whitelist' : 'none',
    filterPatterns: p?.blacklist?.length ? p.blacklist.join('\n') : p?.whitelist?.length ? p.whitelist.join('\n') : '',
    selection: p?.selection ?? (p?.weights?.length ? 'weighted' : 'priority'),
    weights: (p?.weights || []).map((w: any) => ({ pattern: String(w.pattern ?? ''), weight: String(w.weight ?? 1) })),
  };
};

const buildTierPolicy = (f: TierPolicyForm): Record<string, unknown> => {
  const policy: Record<string, unknown> = {};
  // Smart match — only the fields the user actually filled; blanks keep the
  // built-in baseline (backend providers/tier-match.ts DEFAULT_TIER_MATCH).
  const match: Record<string, unknown> = {};
  const mp = splitPatterns(f.matchPatterns);
  if (mp.length) match.patterns = mp;
  const matchMin = parseNum(f.matchMinInputPerM);
  const matchMax = parseNum(f.matchMaxInputPerM);
  if (matchMin != null) match.minInputPerM = matchMin;
  if (matchMax != null) match.maxInputPerM = matchMax;
  if (Object.keys(match).length > 0) policy.match = match;
  // Blacklist / whitelist are mutually exclusive — the mode selector guarantees it.
  const pats = splitPatterns(f.filterPatterns);
  if (f.filterMode === 'blacklist' && pats.length) policy.blacklist = pats;
  else if (f.filterMode === 'whitelist' && pats.length) policy.whitelist = pats;
  policy.selection = f.selection;
  const weights = f.weights
    .map((w) => ({ pattern: w.pattern.trim(), weight: Math.max(1, Math.round(Number(w.weight) || 1)) }))
    .filter((w) => w.pattern);
  if (weights.length) policy.weights = weights;
  return policy;
};

const REASON_LABEL_KEY: Record<string, string> = {
  blacklist: 'tierPolicy.reasonBlacklist',
  whitelist: 'tierPolicy.reasonWhitelist',
};

/** Provider logo via the cached catalog proxy; falls back to the initial letter. */
const ProviderLogo: React.FC<{ providerId: string; logoMap: Record<string, string>; size?: number }> = ({
  providerId,
  logoMap,
  size = 16,
}) => {
  const [failed, setFailed] = useState(false);
  const url = logoMap[providerId];
  if (!url || failed) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 4,
          background: 'var(--card-border)',
          color: 'var(--text-dim)',
          fontSize: Math.round(size * 0.62),
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          textTransform: 'uppercase',
        }}
      >
        {providerId.charAt(0)}
      </span>
    );
  }
  return (
    <img
      src={`/api/ui/catalog/logo?url=${encodeURIComponent(url)}`}
      width={size}
      height={size}
      alt={providerId}
      loading="lazy"
      style={{ borderRadius: 4, objectFit: 'contain', flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
};

export const RulesPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [forms, setForms] = useState<Record<Tier, TierPolicyForm>>({
    fast: defaultFormFor('fast'),
    flagship: defaultFormFor('flagship'),
    reasoning: defaultFormFor('reasoning'),
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pools, setPools] = useState<Record<string, TierPoolInfo>>({});
  const [poolsError, setPoolsError] = useState<string | null>(null);
  const [poolModalTier, setPoolModalTier] = useState<Tier | null>(null);
  const [poolFilter, setPoolFilter] = useState('');
  const [logoMap, setLogoMap] = useState<Record<string, string>>({});
  useBodyScrollLock(!!poolModalTier);

  const loadPools = useCallback(async () => {
    try {
      const res = await api.getTierPools();
      setPools(res.pools || {});
      setPoolsError(null);
    } catch (err: any) {
      setPoolsError(err?.message || 'error');
    }
  }, []);

  // provider id → logo URL (OCR catalog view); logos are decorative, failures ignored
  const ensureLogos = useCallback(async () => {
    try {
      const res = await opencodeApi.listProviders();
      const map: Record<string, string> = {};
      for (const p of res?.providers || []) if (p.id && p.logo) map[p.id] = p.logo as string;
      setLogoMap(map);
    } catch {
      // decorative only
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getConfig();
        const tiers = cfg?.tiers || {};
        setForms({
          fast: formFromPolicy('fast', tiers.fast),
          flagship: formFromPolicy('flagship', tiers.flagship),
          reasoning: formFromPolicy('reasoning', tiers.reasoning),
        });
        await loadPools();
      } catch (err: any) {
        toast.error(t('common.failed') + err.message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateForm = (tier: Tier, patch: Partial<TierPolicyForm>) =>
    setForms((prev) => ({ ...prev, [tier]: { ...prev[tier], ...patch } }));

  // Per-tier reset: restore suggested defaults (form-local until saved).
  const resetTier = (tier: Tier) => setForms((prev) => ({ ...prev, [tier]: defaultFormFor(tier) }));

  const handleSave = async () => {
    setSaving(true);
    try {
      // Tiers whose fields are all blank are omitted → the backend's
      // whole-object `tiers` replacement drops their policies (clear = remove).
      const tiers: Record<string, unknown> = {};
      for (const { key } of TIERS) {
        const policy = buildTierPolicy(forms[key]);
        if (Object.keys(policy).length > 0) tiers[key] = policy;
      }
      await api.saveConfig({ tiers });
      toast.success(t('tierPolicy.saved'));
      await loadPools();
    } catch (err: any) {
      toast.error(t('common.saveFailed') + err.message);
    } finally {
      setSaving(false);
    }
  };

  const openPoolModal = (tier: Tier) => {
    setPoolModalTier(tier);
    setPoolFilter('');
    loadPools();
    ensureLogos();
  };

  /** Add a pool model to the tier's blacklist — writes to the FORM (mode → blacklist, one id per line); persisted by 保存全部策略. */
  const addToBlacklist = (tier: Tier, modelId: string) => {
    setForms((prev) => {
      const f = prev[tier];
      const lines = splitPatterns(f.filterPatterns);
      if (lines.includes(modelId)) return prev;
      return { ...prev, [tier]: { ...f, filterMode: 'blacklist', filterPatterns: [...lines, modelId].join('\n') } };
    });
    setPoolModalTier(null);
    toast.success(t('tierPolicy.addedToBlacklist'));
  };

  const labelStyle = { fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' } as const;

  const modalTierMeta = poolModalTier ? TIERS.find((x) => x.key === poolModalTier) : undefined;
  const modalPool = poolModalTier ? pools[poolModalTier] : undefined;
  const modalStrategy: SelectionStrategy = poolModalTier ? forms[poolModalTier].selection : 'priority';
  const modalTotalWeight = modalPool?.pool.reduce((s, m) => s + m.weight, 0) ?? 0;
  const modalQ = poolFilter.trim().toLowerCase();
  const modalVisiblePool =
    modalPool?.pool.filter((m) => !modalQ || m.id.toLowerCase().includes(modalQ) || m.provider.toLowerCase().includes(modalQ)) ?? [];
  const modalVisibleExcluded = modalPool?.excluded.filter((e) => !modalQ || e.id.toLowerCase().includes(modalQ)) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Zap size={18} color="var(--accent)" />
            <span>{t('tierPolicy.title')}</span>
          </div>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            <Save size={13} />
            <span>{saving ? t('common.loading') : t('tierPolicy.saveBtn')}</span>
          </button>
        </div>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '6px' }}>{t('tierPolicy.desc')}</p>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('tierPolicy.defaultsHint')}</div>
      </div>

      {/* One policy card per tier */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px' }}>
        {TIERS.map(({ key: tier, labelKey, icon: Icon, color }) => {
          const f = forms[tier];
          const poolInfo = pools[tier];
          return (
            <div
              key={tier}
              style={{
                background: 'var(--card-bg)',
                border: '1px solid var(--card-border)',
                borderRadius: '10px',
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700, color }}>
                  <Icon size={16} />
                  <span>{t(labelKey)}</span>
                </div>
                <button
                  className="btn"
                  style={{ padding: '3px 10px', fontSize: '11px', flexShrink: 0 }}
                  title={t('tierPolicy.resetHint')}
                  onClick={() => resetTier(tier)}
                >
                  <RotateCcw size={11} />
                  <span>{t('tierPolicy.resetBtn')}</span>
                </button>
              </div>

              {/* Smart match — classification rules that put models INTO this
                  tier at boot (blank fields = built-in baseline, shown as
                  placeholders). Takes effect on gateway restart. */}
              <div>
                <label style={labelStyle}>{t('tierPolicy.matchTitle')}</label>
                <textarea
                  rows={2}
                  className="input"
                  style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', resize: 'vertical' }}
                  placeholder={(DEFAULT_TIER_MATCH[tier].patterns || []).join('\n')}
                  value={f.matchPatterns}
                  onChange={(e) => updateForm(tier, { matchPatterns: e.target.value })}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '6px' }}>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    className="input"
                    placeholder={t('tierPolicy.minInput')}
                    value={f.matchMinInputPerM}
                    onChange={(e) => updateForm(tier, { matchMinInputPerM: e.target.value })}
                  />
                  <input
                    type="number"
                    step="any"
                    min={0}
                    className="input"
                    placeholder={t('tierPolicy.maxInput')}
                    value={f.matchMaxInputPerM}
                    onChange={(e) => updateForm(tier, { matchMaxInputPerM: e.target.value })}
                  />
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px' }}>{t('tierPolicy.matchHint')}</div>
              </div>

              {/* Selection strategy + weights */}
              <div>
                <label style={labelStyle}>{t('tierPolicy.selection')}</label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  {(['priority', 'weighted', 'round_robin'] as SelectionStrategy[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={f.selection === s ? 'btn btn-primary' : 'btn'}
                      style={{ fontSize: '12px', flex: 1 }}
                      onClick={() => updateForm(tier, { selection: s })}
                    >
                      {t(s === 'priority' ? 'tierPolicy.selPriority' : s === 'weighted' ? 'tierPolicy.selWeighted' : 'tierPolicy.selRoundRobin')}
                    </button>
                  ))}
                </div>

                <label style={labelStyle}>{t('tierPolicy.weightsTitle')}</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {f.weights.map((w, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        className="input"
                        style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                        placeholder={t('tierPolicy.weightPatternPlaceholder')}
                        value={w.pattern}
                        onChange={(e) => {
                          const weights = [...f.weights];
                          weights[i] = { ...weights[i], pattern: e.target.value };
                          updateForm(tier, { weights });
                        }}
                      />
                      <input
                        type="number"
                        min={1}
                        className="input"
                        style={{ width: '84px' }}
                        placeholder={t('tierPolicy.weightPlaceholder')}
                        value={w.weight}
                        onChange={(e) => {
                          const weights = [...f.weights];
                          weights[i] = { ...weights[i], weight: e.target.value };
                          updateForm(tier, { weights });
                        }}
                      />
                      <button
                        className="btn"
                        style={{ padding: '4px 8px' }}
                        onClick={() => updateForm(tier, { weights: f.weights.filter((_, j) => j !== i) })}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <div>
                    <button
                      className="btn"
                      style={{ padding: '4px 10px', fontSize: '11px' }}
                      onClick={() => updateForm(tier, { weights: [...f.weights, { pattern: '', weight: '1' }] })}
                    >
                      <Plus size={11} />
                      <span>{t('tierPolicy.addWeight')}</span>
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px' }}>{t('tierPolicy.selectionHint')}</div>
              </div>

              {/* Blacklist / whitelist — mutually exclusive */}
              <div>
                <label style={labelStyle}>{t('tierPolicy.filterMode')}</label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: f.filterMode !== 'none' ? '8px' : '0' }}>
                  {(['none', 'blacklist', 'whitelist'] as FilterMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={f.filterMode === mode ? 'btn btn-primary' : 'btn'}
                      style={{ fontSize: '12px', flex: 1 }}
                      onClick={() => updateForm(tier, { filterMode: mode })}
                    >
                      {t(mode === 'none' ? 'tierPolicy.filterNone' : mode === 'blacklist' ? 'tierPolicy.filterBlacklist' : 'tierPolicy.filterWhitelist')}
                    </button>
                  ))}
                </div>
                {f.filterMode !== 'none' && (
                  <>
                    <label style={labelStyle}>
                      {t(f.filterMode === 'blacklist' ? 'tierPolicy.blacklist' : 'tierPolicy.whitelist')}
                    </label>
                    <textarea
                      rows={3}
                      className="input"
                      style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', resize: 'vertical' }}
                      placeholder={t('tierPolicy.patternsPlaceholder')}
                      value={f.filterPatterns}
                      onChange={(e) => updateForm(tier, { filterPatterns: e.target.value })}
                    />
                  </>
                )}
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '4px' }}>{t('tierPolicy.patternHint')}</div>
              </div>

              {/* Candidate pool summary → opens the detail modal */}
              <div
                style={{
                  borderTop: '1px solid var(--card-border)',
                  paddingTop: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                }}
              >
                <span
                  style={{
                    fontSize: '11px',
                    color: poolsError ? 'var(--accent-rose)' : 'var(--text-dim)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {poolsError
                    ? poolsError.includes('404')
                      ? t('tierPolicy.poolUnavailable')
                      : t('tierPolicy.poolLoadFailed')
                    : poolInfo
                      ? `${t('tierPolicy.poolTitle')} ${poolInfo.pool.length} · ${t('tierPolicy.excludedTitle')} ${poolInfo.excluded.length}`
                      : `${t('tierPolicy.poolTitle')} …`}
                </span>
                <button className="btn" style={{ padding: '3px 10px', fontSize: '11px', flexShrink: 0 }} onClick={() => openPoolModal(tier)}>
                  <Eye size={11} />
                  <span>{t('tierPolicy.viewPool')}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Candidate pool detail modal — portal to body (page-level modal, z-index 100) */}
      {poolModalTier &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.85)',
              zIndex: 100,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '16px',
            }}
          >
            <div
              className="card"
              style={{
                width: '100%',
                maxWidth: '860px',
                maxHeight: '80vh',
                overflow: 'hidden',
                padding: '24px',
                boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {modalTierMeta && <modalTierMeta.icon size={15} color={modalTierMeta.color} />}
                  <span>{modalTierMeta ? t(modalTierMeta.labelKey) : ''} · {t('tierPolicy.poolTitle')}</span>
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {modalQ && (
                    <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                      {modalVisiblePool.length}/{modalPool?.pool.length ?? 0}
                    </span>
                  )}
                  <button className="btn" style={{ padding: '3px 10px', fontSize: '11px' }} onClick={loadPools}>
                    <RefreshCw size={11} />
                    <span>{t('tierPolicy.refresh')}</span>
                  </button>
                  <button
                    onClick={() => setPoolModalTier(null)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div style={{ position: 'relative', flexShrink: 0 }}>
                <Search
                  size={13}
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
                />
                <input
                  type="text"
                  className="input"
                  style={{ paddingLeft: '30px', fontSize: '12px' }}
                  placeholder={t('tierPolicy.poolSearch')}
                  value={poolFilter}
                  onChange={(e) => setPoolFilter(e.target.value)}
                />
              </div>

              <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {poolsError ? (
                <div
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    background: 'rgba(244, 63, 94, 0.12)',
                    border: '1px solid rgba(244, 63, 94, 0.3)',
                    color: 'var(--accent-rose)',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                  }}
                >
                  <span>
                    {poolsError.includes('404')
                      ? t('tierPolicy.poolUnavailable')
                      : `${t('tierPolicy.poolLoadFailed')} (${poolsError})`}
                  </span>
                  <button className="btn" style={{ padding: '3px 10px', fontSize: '11px', flexShrink: 0 }} onClick={loadPools}>
                    <RefreshCw size={11} />
                    <span>{t('tierPolicy.poolRetry')}</span>
                  </button>
                </div>
              ) : !modalPool ? (
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {/* header */}
                    <div
                      style={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '4px 8px',
                        borderBottom: '1px solid var(--card-border)',
                        fontSize: '10px',
                        fontWeight: 700,
                        color: 'var(--text-dim)',
                        background: 'var(--card-bg)',
                        backdropFilter: 'blur(16px)',
                      }}
                    >
                      <span style={{ width: 7, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>{t('tierPolicy.colModel')}</span>
                      <span style={{ flexShrink: 0, fontFamily: 'JetBrains Mono, monospace' }}>
                        {t('tierPolicy.colInput')} / {t('tierPolicy.colOutput')} · {t('tierPolicy.colWeight')}
                        {modalStrategy !== 'priority' ? ` · ${t('tierPolicy.colShare')}` : ''}
                      </span>
                      <span style={{ width: 96, flexShrink: 0, textAlign: 'right' }}>{t('tierPolicy.colActions')}</span>
                    </div>

                    {modalVisiblePool.length === 0 ? (
                      <div style={{ padding: '10px 8px', fontSize: '12px', color: 'var(--accent-rose)' }}>
                        {modalQ ? t('common.noResults') : t('tierPolicy.poolEmpty')}
                      </div>
                    ) : (
                      modalVisiblePool.map((m, idx) => {
                        const blacklisted =
                          forms[poolModalTier].filterMode === 'blacklist' &&
                          splitPatterns(forms[poolModalTier].filterPatterns).includes(m.id);
                        const segs = [
                          `$${m.inputPrice ?? '?'} / $${m.outputPrice ?? '?'}`,
                          `${m.weight}x`,
                          ...(modalStrategy !== 'priority' && modalTotalWeight > 0
                            ? [`${Math.round((m.weight / modalTotalWeight) * 100)}%`]
                            : []),
                          ...(m.priority != null ? [`P${m.priority}`] : []),
                        ].join(' · ');
                        return (
                          <div
                            key={m.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '6px 8px',
                              borderBottom: '1px solid var(--card-border)',
                              fontSize: '12px',
                            }}
                          >
                            <span
                              title={m.healthy ? t('tierPolicy.poolHealthy') : t('tierPolicy.poolUnhealthy')}
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: m.healthy ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                                flexShrink: 0,
                              }}
                            />
                            <ProviderLogo providerId={m.provider} logoMap={logoMap} />
                            <span
                              title={`${m.provider} / ${m.id}`}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                fontFamily: 'JetBrains Mono, monospace',
                                fontWeight: 600,
                              }}
                            >
                              {m.id}
                            </span>
                            {modalStrategy === 'priority' && idx === 0 && (
                              <span
                                style={{
                                  flexShrink: 0,
                                  fontSize: 9,
                                  padding: '1px 5px',
                                  borderRadius: 999,
                                  border: '1px solid var(--accent)',
                                  color: 'var(--accent)',
                                }}
                              >
                                {t('tierPolicy.preferredBadge')}
                              </span>
                            )}
                            <span style={{ flexShrink: 0, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>
                              {segs}
                            </span>
                            <span style={{ width: 96, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
                              {blacklisted ? (
                                <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{t('tierPolicy.alreadyBlacklisted')}</span>
                              ) : (
                                <button
                                  className="btn"
                                  style={{ padding: '2px 8px', fontSize: '10px' }}
                                  title={t('tierPolicy.addToBlacklist')}
                                  onClick={() => addToBlacklist(poolModalTier, m.id)}
                                >
                                  <Ban size={10} />
                                  <span>{t('tierPolicy.addToBlacklist')}</span>
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {modalVisibleExcluded.length > 0 && (
                    <details style={{ marginTop: '12px', flexShrink: 0 }}>
                      <summary
                        style={{
                          cursor: 'pointer',
                          fontSize: '10px',
                          fontWeight: 700,
                          color: 'var(--text-dim)',
                          userSelect: 'none',
                          padding: '4px 8px',
                          borderRadius: 6,
                        }}
                      >
                        {t('tierPolicy.excludedTitle')} ({modalVisibleExcluded.length})
                      </summary>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '6px' }}>
                        {modalVisibleExcluded.map((e) => (
                          <span
                            key={e.id}
                            style={{
                              fontSize: '10px',
                              padding: '2px 7px',
                              borderRadius: 6,
                              background: 'rgba(244, 63, 94, 0.12)',
                              border: '1px solid rgba(244, 63, 94, 0.3)',
                              color: 'var(--accent-rose)',
                              fontFamily: 'JetBrains Mono, monospace',
                            }}
                          >
                            {e.id} · {t(REASON_LABEL_KEY[e.reason] || e.reason)}
                          </span>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
