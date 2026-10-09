import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Zap, Scale, Brain, Save, RefreshCw, Plus, X, RotateCcw, Eye, Search } from 'lucide-react';
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

type SelectionStrategy = 'priority' | 'weighted' | 'round_robin';

interface TierPolicyForm {
  matchPatterns: string; // textarea, one wildcard pattern per line; untouched = omitted (default), touched+cleared = saves [] (closes condition)
  matchPatternsTouched: boolean; // true = user edited (incl. cleared); false = untouched
  matchMinInputPerM: string;
  matchMaxInputPerM: string;
  excludePatterns: string; // per-tier veto on auto-claim — SAME meaning for every tier (ADR-0012)
  excludePatternsTouched: boolean; // true = user edited (incl. cleared); false = untouched
  matchExcludeTiers: Tier[]; // ADR-0012 anchor-exclude: models matching these tiers' conditions are not claimed here
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

// The match inputs come PRE-FILLED with the built-in baseline (editable as-is).
// An UNTOUCHED field is omitted on save → the backend falls back to its
// baseline (providers/tier-match.ts). A TOUCHED field is saved as-is: clearing
// it writes `[]`, closing the condition instead of restoring the default.
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
  matchPatternsTouched: false,
  excludePatternsTouched: false,
  excludePatterns: '',
  matchExcludeTiers: [],
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
  return {
    ...dm,
    ...withDefaults,
    excludePatterns: p?.match?.exclude?.join('\n') ?? '',
    // Key present in saved config (even []) = explicit user state → touched.
    matchPatternsTouched: p?.match?.patterns != null,
    excludePatternsTouched: p?.match?.exclude != null,
    matchExcludeTiers: (Array.isArray(p?.match?.excludeTiers) ? p.match.excludeTiers : []).filter(
      (x: unknown): x is Tier => x === 'fast' || x === 'flagship' || x === 'reasoning',
    ),
    selection: p?.selection ?? (p?.weights?.length ? 'weighted' : 'priority'),
    weights: (p?.weights || []).map((w: any) => ({ pattern: String(w.pattern ?? ''), weight: String(w.weight ?? 1) })),
  };
};

const buildTierPolicy = (f: TierPolicyForm): Record<string, unknown> => {
  const policy: Record<string, unknown> = {};
  // Smart match — only the fields the user TOUCHED; untouched blanks keep the
  // built-in baseline (backend providers/tier-match.ts DEFAULT_TIER_MATCH),
  // while a touched-but-cleared field writes [] to close the condition.
  // ADR-0012: every tier is configured IDENTICALLY (patterns + price band +
  // exclude + anchor-exclude tiers). tiers.exclude (global denylist) is not
  // managed here — it round-trips untouched.
  const match: Record<string, unknown> = {};
  const mp = splitPatterns(f.matchPatterns);
  if (f.matchPatternsTouched) match.patterns = mp;
  const matchMin = parseNum(f.matchMinInputPerM);
  const matchMax = parseNum(f.matchMaxInputPerM);
  if (matchMin != null) match.minInputPerM = matchMin;
  if (matchMax != null) match.maxInputPerM = matchMax;
  const ex = splitPatterns(f.excludePatterns);
  if (f.excludePatternsTouched) match.exclude = ex;
  if (f.matchExcludeTiers.length) match.excludeTiers = f.matchExcludeTiers;
  if (Object.keys(match).length > 0) policy.match = match;
  policy.selection = f.selection;
  const weights = f.weights
    .map((w) => ({ pattern: w.pattern.trim(), weight: Math.max(1, Math.round(Number(w.weight) || 1)) }))
    .filter((w) => w.pattern);
  if (weights.length) policy.weights = weights;
  return policy;
};

const REASON_LABEL_KEY: Record<string, string> = {
  exclude: 'tierPolicy.reasonExclude',
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
  // tiers.exclude (GLOBAL denylist) has no card on this page — it is edited on
  // the raw-YAML page. It is still round-tripped here because the backend
  // replaces the whole `tiers` object on save (omitting it would wipe it).
  const [globalExclude, setGlobalExclude] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pools, setPools] = useState<Record<string, TierPoolInfo>>({});
  const [poolsLive, setPoolsLive] = useState<Record<string, TierPoolInfo>>({});
  const [poolsError, setPoolsError] = useState<string | null>(null);
  const [poolModalTier, setPoolModalTier] = useState<Tier | null>(null);
  const [poolMode, setPoolMode] = useState<'preview' | 'live'>('preview');
  const [poolFilter, setPoolFilter] = useState('');
  const [logoMap, setLogoMap] = useState<Record<string, string>>({});
  const [poolsLoadingMode, setPoolsLoadingMode] = useState<'preview' | 'live' | null>(null);
  const [poolsAt, setPoolsAt] = useState<number | null>(null);
  const [poolsLiveAt, setPoolsLiveAt] = useState<number | null>(null);
  useBodyScrollLock(!!poolModalTier);

  const buildTiersPayload = useCallback((): Record<string, unknown> => {
    const tiers: Record<string, unknown> = {};
    for (const { key } of TIERS) {
      const policy = buildTierPolicy(forms[key]);
      if (Object.keys(policy).length > 0) tiers[key] = policy;
    }
    const ex = splitPatterns(globalExclude);
    if (ex.length) tiers.exclude = ex;
    return tiers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forms, globalExclude]);

  // Pool numbers = EPHEMERAL preview computed from the current FORM state
  // (server-side pure projection, live pools untouched). Real membership is
  // rewritten only by handleSave → applyTierConfigNow commit.
  //
  // The card footer count is driven by `poolsLive` (committed state) — what
  // routing will actually use after the next save — NOT by `pools` (the form
  // preview, which jumps on every keystroke). The preview pool is only shown
  // inside the detail modal, where its ephemeral nature is explicit.
  const loadPools = useCallback(async () => {
    setPoolsLoadingMode('preview');
    try {
      const res = await api.previewTierPools(buildTiersPayload());
      setPools(res.pools || {});
      setPoolsAt(Date.now());
      setPoolsError(null);
    } catch (err: any) {
      setPoolsError(err?.message || 'error');
    } finally {
      setPoolsLoadingMode(null);
    }
  }, [buildTiersPayload]);

  /** Live (committed) pool snapshot — the registry's m.tier after the last applyTierConfigNow. */
  const loadLivePools = useCallback(async () => {
    setPoolsLoadingMode('live');
    try {
      const res = await api.getLiveTierPools();
      setPoolsLive(res.pools || {});
      setPoolsLiveAt(Date.now());
    } catch (err: any) {
      // Live endpoint is best-effort; preview endpoint already surfaces errors.
    } finally {
      setPoolsLoadingMode(null);
    }
  }, []);

  // Debounced live preview while editing the form.
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => void loadPools(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forms, globalExclude, loading]);

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
        setGlobalExclude((tiers.exclude || []).join('\n'));
        await loadPools();
        await loadLivePools();
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
      await api.saveConfig({ tiers: buildTiersPayload() });
      toast.success(t('tierPolicy.saved'));
      await loadPools();
      await loadLivePools();
    } catch (err: any) {
      toast.error(t('common.saveFailed') + err.message);
    } finally {
      setSaving(false);
    }
  };

  const openPoolModal = (tier: Tier) => {
    setPoolModalTier(tier);
    setPoolFilter('');
    setPoolMode('preview');
    void loadPools();
    void loadLivePools();
    ensureLogos();
  };

  /** Add a model to the GLOBAL denylist (exact id) — writes tiers.exclude (ADR-0012: its own field). */
  const addToExclude = (modelId: string) => {
    setGlobalExclude((prev) => {
      const lines = splitPatterns(prev);
      if (lines.includes(modelId)) return prev;
      return [...lines, modelId].join('\n');
    });
    // Intentionally keep the pool modal open so the user can batch-exclude multiple models
    // without re-opening it. The model disappears from the candidate list and reappears
    // in the "被策略排除" section below — both visible in the same view.
    toast.success(t('tierPolicy.addedToExclude'));
  };

  /** Remove a model from the GLOBAL denylist — restores it as unclassified (still callable by id). */
  const removeFromExclude = (modelId: string) => {
    setGlobalExclude((prev) => {
      const lines = splitPatterns(prev).filter((x) => x !== modelId);
      return lines.join('\n');
    });
    toast.success(t('tierPolicy.removedFromExclude'));
  };

  const labelStyle = { fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' } as const;

  const modalTierMeta = poolModalTier ? TIERS.find((x) => x.key === poolModalTier) : undefined;
  const modalPoolSet = poolModalTier ? (poolMode === 'live' ? poolsLive[poolModalTier] : pools[poolModalTier]) : undefined;
  const modalPool = modalPoolSet;
  const modalStrategy: SelectionStrategy = poolModalTier ? forms[poolModalTier].selection : 'priority';
  const modalTotalWeight = modalPool?.pool.reduce((s, m) => s + m.weight, 0) ?? 0;
  const modalQ = poolFilter.trim().toLowerCase();
  const modalVisiblePool =
    modalPool?.pool.filter((m) => !modalQ || m.id.toLowerCase().includes(modalQ) || m.provider.toLowerCase().includes(modalQ)) ?? [];
  const modalVisibleExcluded = modalPool?.excluded.filter((e) => !modalQ || e.id.toLowerCase().includes(modalQ)) ?? [];

  // Virtual scroll: row height is fixed (row style below uses 6px+12px+1px = 38px).
  // 50+ row pools would otherwise mount ~50 logos + buttons; viewport render
  // keeps DOM work proportional to visible rows regardless of pool size.
  //
  // Layout (C-style pure flow, no sticky): list-header sits above the scroll
  // container, status bar below it — both are flex-shrink:0 siblings of the
  // scroll container, never overlap rows, never need to reserve pixel space.
  const ROW_H = 38;
  const OVERSCAN = 10;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    setScrollTop(0); // fresh container = fresh scroll position
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [poolModalTier]); // reset when modal opens (different tier)
  const virtual = useMemo(() => {
    const total = modalVisiblePool.length;
    if (viewportH === 0) return { start: 0, end: total, total, padTop: 0, padBottom: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const visibleRows = Math.max(1, Math.ceil(viewportH / ROW_H)) + OVERSCAN * 2;
    const end = Math.min(total, start + visibleRows);
    return { start, end, total, padTop: start * ROW_H, padBottom: (total - end) * ROW_H };
  }, [modalVisiblePool.length, scrollTop, viewportH]);

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
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', margin: 0, marginBottom: '6px', whiteSpace: 'pre-line' }}>{t('tierPolicy.desc')}</p>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '6px' }}>{t('tierPolicy.defaultsHint')}</div>
      </div>

      {/* One policy card per tier */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px' }}>
        {TIERS.map(({ key: tier, labelKey, icon: Icon, color }) => {
          const f = forms[tier];
          // Card footer = EPHEMERAL preview from the current form (debounced
          // 500ms via loadPools). Updates as the user edits, so the count
          // reflects "what would happen if I saved now" — not the committed
          // state. For the committed (post-save) state, use the detail modal
          // and switch to the 实时 tab.
          const poolInfo = pools[tier] ?? poolsLive[tier];
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
                  onChange={(e) => updateForm(tier, { matchPatterns: e.target.value, matchPatternsTouched: true })}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '6px' }}>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    className="input"
                    placeholder={t('tierPolicy.minInputPrice')}
                    value={f.matchMinInputPerM}
                    onChange={(e) => updateForm(tier, { matchMinInputPerM: e.target.value })}
                  />
                  <input
                    type="number"
                    step="any"
                    min={0}
                    className="input"
                    placeholder={t('tierPolicy.maxInputPrice')}
                    value={f.matchMaxInputPerM}
                    onChange={(e) => updateForm(tier, { matchMaxInputPerM: e.target.value })}
                  />
                </div>
                <label style={{ ...labelStyle, marginTop: '8px' }}>{t('tierPolicy.tierExcludeLabel')}</label>
                <textarea
                  rows={2}
                  className="input"
                  style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', resize: 'vertical' }}
                  placeholder={t('tierPolicy.excludePlaceholder')}
                  value={f.excludePatterns}
                  onChange={(e) => updateForm(tier, { excludePatterns: e.target.value, excludePatternsTouched: true })}
                />
                <label style={{ ...labelStyle, marginTop: '8px' }}>{t('tierPolicy.excludeTiersLabel')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {TIERS.filter((x) => x.key !== tier).map(({ key: other, labelKey }) => {
                    const on = f.matchExcludeTiers.includes(other);
                    return (
                      <button
                        key={other}
                        type="button"
                        className={on ? 'btn btn-primary' : 'btn'}
                        style={{ fontSize: '11px', padding: '3px 9px' }}
                        title={t('tierPolicy.excludeTiersHint')}
                        onClick={() =>
                          updateForm(tier, {
                            matchExcludeTiers: on
                              ? f.matchExcludeTiers.filter((x) => x !== other)
                              : [...f.matchExcludeTiers, other],
                          })
                        }
                      >
                        {on ? <X size={10} /> : <Plus size={10} />}
                        <span>{t(labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
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
          <>
            <style>{`@keyframes ocr-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
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
                  <span>
                    {modalTierMeta ? t(modalTierMeta.labelKey) : ''} ·{' '}
                    {t('tierPolicy.poolTitleBase', {
                      mode: t(poolMode === 'live' ? 'tierPolicy.poolTabLive' : 'tierPolicy.poolTabPreview'),
                    })}
                  </span>
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: 0, border: '1px solid var(--card-border)', borderRadius: 6, padding: 2 }}>
                    {(['preview', 'live'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setPoolMode(m);
                          if (m === 'live') void loadLivePools();
                          else void loadPools();
                        }}
                        className={poolMode === m ? 'btn btn-primary' : 'btn'}
                        style={{ padding: '2px 10px', fontSize: '11px', borderRadius: 4 }}
                        title={t(m === 'preview' ? 'tierPolicy.poolTabPreviewHint' : 'tierPolicy.poolTabLiveHint')}
                      >
                        {t(m === 'preview' ? 'tierPolicy.poolTabPreview' : 'tierPolicy.poolTabLive')}
                        {poolMode === m && poolsLoadingMode === m && (
                          <span style={{ marginLeft: 6, fontSize: 9, animation: 'ocr-spin 0.9s linear infinite', display: 'inline-block' }}>↻</span>
                        )}
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const at = poolMode === 'live' ? poolsLiveAt : poolsAt;
                    return at ? (
                      <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                        {t('tierPolicy.refreshedAt')} {new Date(at).toLocaleTimeString()}
                      </span>
                    ) : null;
                  })()}
                  {modalPool && (
                    <span
                      title={`${t('tierPolicy.poolTitle')} ${modalPool.pool.length} · ${t('tierPolicy.excludedTitle')} ${modalPool.excluded.length}`}
                      style={{
                        fontSize: '10px',
                        color: 'var(--text-dim)',
                        fontFamily: 'JetBrains Mono, monospace',
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: 'var(--card-border)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('tierPolicy.poolCount', { n: modalPool.pool.length })}
                      {modalQ ? ` · ${t('tierPolicy.poolFilteredCount', { shown: modalVisiblePool.length, total: modalPool.pool.length })}` : ''}
                      {' · '}
                      {modalPool.excluded.length}
                    </span>
                  )}
                  <button
                    className="btn"
                    style={{ padding: '3px 10px', fontSize: '11px', opacity: poolsLoadingMode === poolMode ? 0.7 : 1 }}
                    title={t('tierPolicy.refreshHint')}
                    disabled={poolsLoadingMode !== null}
                    onClick={() => void (poolMode === 'live' ? loadLivePools() : loadPools())}
                  >
                    <RefreshCw
                      size={11}
                      style={poolsLoadingMode === poolMode ? { animation: 'ocr-spin 0.9s linear infinite' } : undefined}
                    />
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
                  <button
                    className="btn"
                    style={{ padding: '3px 10px', fontSize: '11px', flexShrink: 0 }}
                    disabled={poolsLoadingMode !== null}
                    onClick={() => void loadPools()}
                  >
                    <RefreshCw size={11} />
                    <span>{t('tierPolicy.poolRetry')}</span>
                  </button>
                </div>
              ) : !modalPool ? (
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
              ) : (
                <>
                  {/* List header — pure flow sibling of the scroll container,
                      never overlaps rows. Sits above the scroll viewport. */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 8px',
                      borderBottom: '1px solid var(--card-border)',
                      fontSize: '10px',
                      fontWeight: 700,
                      color: 'var(--text-dim)',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ width: 7, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>{t('tierPolicy.colModel')}</span>
                    <span style={{ flexShrink: 0, fontFamily: 'JetBrains Mono, monospace' }}>
                      {t('tierPolicy.colInput')} / {t('tierPolicy.colOutput')} · {t('tierPolicy.colWeight')}
                      {modalStrategy !== 'priority' ? ` · ${t('tierPolicy.colShare')}` : ''}
                    </span>
                    <span style={{ width: 172, flexShrink: 0, textAlign: 'right' }}>{t('tierPolicy.colActions')}</span>
                  </div>

                  <div
                    key={poolModalTier ?? 'closed'}
                    ref={scrollRef}
                    onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
                    style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
                  >
                    {modalVisiblePool.length === 0 ? (
                      <div style={{ padding: '10px 8px', fontSize: '12px', color: 'var(--accent-rose)' }}>
                        {modalQ ? t('common.noResults') : t('tierPolicy.poolEmpty')}
                      </div>
                    ) : (
                      <>
                        {virtual.padTop > 0 && <div style={{ height: virtual.padTop }} />}
                        {modalVisiblePool.slice(virtual.start, virtual.end).map((m, idx) => {
                          const realIdx = virtual.start + idx;
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
                                height: ROW_H,
                                boxSizing: 'border-box',
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
                              {modalStrategy === 'priority' && realIdx === 0 && (
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
                              <span style={{ width: 172, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                                {splitPatterns(globalExclude).includes(m.id) ? (
                                  <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{t('tierPolicy.alreadyExcluded')}</span>
                                ) : (
                                  <button
                                    className="btn"
                                    style={{ padding: '2px 8px', fontSize: '10px' }}
                                    title={t('tierPolicy.excludeBtnHint')}
                                    onClick={() => addToExclude(m.id)}
                                  >
                                    <X size={10} />
                                    <span>{t('tierPolicy.excludeBtn')}</span>
                                  </button>
                                )}
                              </span>
                            </div>
                          );
                        })}
                        {virtual.padBottom > 0 && <div style={{ height: virtual.padBottom }} />}
                      </>
                    )}
                  </div>

                  {/* Status bar — pure flow sibling below the scroll container,
                      never overlaps rows. Mirrors the top header positionally. */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '4px 10px',
                      fontSize: '10px',
                      fontFamily: 'JetBrains Mono, monospace',
                      color: 'var(--text-dim)',
                      borderTop: '1px solid var(--card-border)',
                      flexShrink: 0,
                      minHeight: 26,
                      boxSizing: 'border-box',
                    }}
                  >
                    <span>
                      {modalVisiblePool.length === 0
                        ? '—'
                        : modalQ
                          ? t('tierPolicy.poolFilteredCount', { shown: modalVisiblePool.length, total: modalPool?.pool.length ?? 0 })
                          : t('tierPolicy.poolRange', {
                              from: Math.min(scrollTop === 0 ? 1 : Math.floor(scrollTop / ROW_H) + 1, modalVisiblePool.length || 1),
                              to: Math.min(Math.ceil((scrollTop + viewportH) / ROW_H), modalVisiblePool.length),
                              total: modalVisiblePool.length,
                            })}
                    </span>
                    <span>
                      {modalPool
                        ? `${t('tierPolicy.excludedTitle')} ${modalPool.excluded.length}`
                        : ''}
                    </span>
                  </div>

                  {modalVisibleExcluded.length > 0 && (
                    <details open style={{ flexShrink: 0 }}>
                      <summary
                        title="被本梯队策略排除的模型 —— 鼠标悬停徽章查看排除原因"
                        style={{
                          cursor: 'pointer',
                          fontSize: '11px',
                          fontWeight: 700,
                          color: 'var(--accent-rose)',
                          userSelect: 'none',
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'rgba(244, 63, 94, 0.06)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          listStyle: 'none',
                        }}
                      >
                        <span aria-hidden style={{ fontSize: '9px', width: 10, display: 'inline-block' }}>▼</span>
                        {t('tierPolicy.excludedTitle')} ({modalVisibleExcluded.length})
                      </summary>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '6px', padding: '0 8px 8px' }}>
                        {modalVisibleExcluded.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            title={`原因：${t(REASON_LABEL_KEY[e.reason] || e.reason)} — 点击从全局排除名单移除`}
                            onClick={() => removeFromExclude(e.id)}
                            style={{
                              fontSize: '10px',
                              padding: '2px 4px 2px 7px',
                              borderRadius: 6,
                              background: 'rgba(244, 63, 94, 0.12)',
                              border: '1px solid rgba(244, 63, 94, 0.3)',
                              color: 'var(--accent-rose)',
                              fontFamily: 'JetBrains Mono, monospace',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <span>{e.id} · {t(REASON_LABEL_KEY[e.reason] || e.reason)}</span>
                            <span
                              aria-hidden
                              style={{
                                fontSize: '11px',
                                lineHeight: 1,
                                padding: '0 3px',
                                borderRadius: 4,
                                background: 'rgba(244, 63, 94, 0.25)',
                              }}
                            >
                              ×
                            </span>
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
};
