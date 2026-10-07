import React, { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ShieldAlert, RefreshCw, Search, RotateCcw, Ban } from 'lucide-react';
import { api, type GatewayStatusResponse, type BreakerInfo } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Pagination } from '../components/Pagination';

const BREAKER_PAGE_SIZE = 20;
const BREAKER_PAGE_SIZES = [10, 20, 50, 100, 200];

type StateFilter = 'ALL' | 'OPEN' | 'HALF_OPEN' | 'CLOSED';

// Tripped first, half-open probes next, healthy last; longer remaining cooldown first within a state
const STATE_ORDER: Record<BreakerInfo['state'], number> = { OPEN: 0, HALF_OPEN: 1, CLOSED: 2 };

const TRIP_PRESETS: { label: string; ms: number }[] = [
  { label: '30m', ms: 30 * 60 * 1000 },
  { label: '1h', ms: 3600 * 1000 },
  { label: '6h', ms: 6 * 3600 * 1000 },
  { label: '12h', ms: 12 * 3600 * 1000 },
  { label: '24h', ms: 24 * 3600 * 1000 },
  { label: '7d', ms: 7 * 24 * 3600 * 1000 },
];

export const GuardrailsPage: React.FC = () => {
  const { status } = useOutletContext<{ status: GatewayStatusResponse | null }>();
  const { t } = useI18n();
  const toast = useToast();
  const [modelFilter, setModelFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('ALL');
  const [breakerPage, setBreakerPage] = useState(1);
  const [breakerPageSize, setBreakerPageSize] = useState(BREAKER_PAGE_SIZE);
  const [isResetting, setIsResetting] = useState(false);
  const [resettingModel, setResettingModel] = useState<string | null>(null);
  const [tripPanelModel, setTripPanelModel] = useState<string | null>(null);
  const [tripReason, setTripReason] = useState('');
  const [trippingModel, setTrippingModel] = useState<string | null>(null);

  const breakers: BreakerInfo[] = status?.circuitBreakers?.breakers || [];
  const openCount = status?.circuitBreakers?.tripped || 0;
  const halfOpenCount = status?.circuitBreakers?.halfOpen || 0;
  const totalBreakers = status?.circuitBreakers?.total || 0;

  const filteredBreakers = breakers
    .filter(b => stateFilter === 'ALL' || b.state === stateFilter)
    .filter(b => b.modelId.toLowerCase().includes(modelFilter.toLowerCase()))
    .sort((a, b) =>
      STATE_ORDER[a.state] !== STATE_ORDER[b.state]
        ? STATE_ORDER[a.state] - STATE_ORDER[b.state]
        : b.remainingCooldownMs - a.remainingCooldownMs
    );
  const pagedBreakers = filteredBreakers.slice(
    (breakerPage - 1) * breakerPageSize,
    breakerPage * breakerPageSize
  );

  const handleResetAll = async () => {
    setIsResetting(true);
    try {
      await api.resetBreakers();
      toast.success(t('guardrails.resetSuccess'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setIsResetting(false);
    }
  };

  const handleResetOne = async (modelId: string) => {
    setResettingModel(modelId);
    try {
      await api.resetBreakers(modelId);
      toast.success(t('guardrails.resetOneSuccess', { model: modelId }));
    } catch (err: any) {
      toast.error(t('guardrails.resetOneFailed') + err.message);
    } finally {
      setResettingModel(null);
    }
  };

  const handleTrip = async (modelId: string, cooldownMs: number) => {
    setTrippingModel(modelId);
    try {
      await api.tripBreaker(modelId, { reason: tripReason.trim() || undefined, cooldownMs });
      toast.success(t('guardrails.tripSuccess', { model: modelId }));
      setTripPanelModel(null);
      setTripReason('');
    } catch (err: any) {
      toast.error(t('guardrails.tripFailed') + err.message);
    } finally {
      setTrippingModel(null);
    }
  };

  const categoryLabel = (cat?: string) => {
    switch (cat) {
      case 'QUOTA_EXHAUSTED': return t('guardrails.catQuota');
      case 'AUTHENTICATION_ERROR': return t('guardrails.catAuth');
      case 'RATE_LIMITED': return t('guardrails.catRate');
      case 'SERVICE_UNAVAILABLE': return t('guardrails.catService');
      case 'CLIENT_ERROR': return t('guardrails.catClient');
      case 'MANUAL': return t('guardrails.catManual');
      default: return t('guardrails.catUnknown');
    }
  };

  const formatCooldown = (ms: number) =>
    ms >= 3600 * 1000
      ? t('guardrails.cooldownH', { h: (ms / (3600 * 1000)).toFixed(1) })
      : t('guardrails.cooldown', { sec: Math.round(ms / 1000) });

  const stateFilters: { key: StateFilter; label: string }[] = [
    { key: 'ALL', label: `${t('guardrails.stateAll')} (${breakers.length})` },
    { key: 'OPEN', label: `${t('guardrails.stateTripped')} (${openCount})` },
    { key: 'HALF_OPEN', label: `${t('guardrails.stateHalfOpen')} (${halfOpenCount})` },
    { key: 'CLOSED', label: t('guardrails.stateHealthy') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Top Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('guardrails.totalBreakers')}</div>
          <div style={{ fontSize: '28px', fontWeight: 800 }}>{totalBreakers}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>{t('guardrails.totalBreakersSub')}</div>
        </div>

        <div className="card">
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('guardrails.openBreakers')}</div>
          <div style={{ fontSize: '28px', fontWeight: 800, color: openCount > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}>
            {openCount}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {openCount > 0 ? t('guardrails.openSubTripped') : t('guardrails.openSubSafe')}
          </div>
          {halfOpenCount > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--accent-amber)', marginTop: '2px' }}>
              {t('guardrails.stateHalfOpen')}: {halfOpenCount}
            </div>
          )}
        </div>
      </div>

      {/* Circuit Breaker Matrix */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <ShieldAlert size={18} color="var(--accent-rose)" />
            <span>{t('guardrails.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-primary" onClick={handleResetAll} disabled={isResetting}>
              <RefreshCw size={13} />
              <span>{isResetting ? t('guardrails.resetting') : t('guardrails.resetAll')}</span>
            </button>
          </div>
        </div>

        {/* Filter Input */}
        <div style={{ marginBottom: '12px', position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
          <input
            type="text"
            value={modelFilter}
            onChange={e => { setModelFilter(e.target.value); setBreakerPage(1); }}
            placeholder={t('guardrails.searchFilter')}
            className="input"
            style={{ paddingLeft: '34px' }}
          />
        </div>

        {/* State Filter Chips */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {stateFilters.map(sf => (
            <button
              key={sf.key}
              className="btn btn-sm"
              onClick={() => { setStateFilter(sf.key); setBreakerPage(1); }}
              style={
                stateFilter === sf.key
                  ? { background: 'var(--accent)', color: 'var(--btn-primary-text)', borderColor: 'var(--accent)' }
                  : undefined
              }
            >
              {sf.label}
            </button>
          ))}
        </div>

        {/* Matrix Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', maxHeight: '560px', overflowY: 'auto' }}>
          {pagedBreakers.length > 0 ? (
            pagedBreakers.map(b => {
              const isClosed = b.state === 'CLOSED';
              const isOpen = b.state === 'OPEN';
              const borderColor = isOpen
                ? 'var(--accent-rose)'
                : b.state === 'HALF_OPEN'
                  ? 'var(--accent-amber)'
                  : 'var(--card-border)';
              return (
                <div
                  key={b.modelId}
                  style={{
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: `1px solid ${borderColor}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 600, fontSize: '13px', fontFamily: 'JetBrains Mono, monospace', overflowWrap: 'anywhere' }}>
                      {b.modelId}
                    </span>
                    <span className={`badge ${isClosed ? 'badge-success' : isOpen ? 'badge-danger' : 'badge-warning'}`}>
                      {b.state}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{b.provider}</div>

                  {!isClosed && b.reason && (
                    <div
                      title={b.reason}
                      style={{
                        fontSize: '11px',
                        color: isOpen ? 'var(--accent-rose)' : 'var(--accent-amber)',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        lineHeight: 1.5,
                      }}
                    >
                      {t('guardrails.reasonLabel')}: {b.reason}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-dim)' }}>
                    <span>{t('guardrails.failures', { count: b.consecutiveFailures })}</span>
                    {b.remainingCooldownMs > 0 && (
                      <span style={{ color: 'var(--accent-amber)' }}>{formatCooldown(b.remainingCooldownMs)}</span>
                    )}
                  </div>

                  {tripPanelModel === b.modelId ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px dashed var(--card-border)' }}>
                      <input
                        type="text"
                        className="input"
                        style={{ fontSize: '12px', padding: '6px 10px' }}
                        placeholder={t('guardrails.tripReasonPlaceholder')}
                        value={tripReason}
                        onChange={e => setTripReason(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {TRIP_PRESETS.map(p => (
                          <button
                            key={p.label}
                            className="btn btn-sm"
                            disabled={trippingModel === b.modelId}
                            onClick={() => handleTrip(b.modelId, p.ms)}
                            style={{ fontSize: '11px', padding: '3px 8px', background: 'var(--accent)', color: 'var(--btn-primary-text)', borderColor: 'var(--accent)' }}
                          >
                            {p.label}
                          </button>
                        ))}
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: '11px', padding: '3px 8px' }}
                          onClick={() => { setTripPanelModel(null); setTripReason(''); }}
                        >
                          {t('guardrails.tripCancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', minHeight: '26px' }}>
                      {!isClosed && (
                        <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginRight: 'auto' }}>
                          {categoryLabel(b.category)}
                        </span>
                      )}
                      {!isClosed ? (
                        <button
                          className="btn btn-sm"
                          disabled={resettingModel === b.modelId}
                          onClick={() => handleResetOne(b.modelId)}
                          style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
                        >
                          <RotateCcw size={12} />
                          <span>{resettingModel === b.modelId ? t('guardrails.resetting') : t('guardrails.resetOne')}</span>
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => { setTripPanelModel(b.modelId); setTripReason(''); }}
                          style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
                        >
                          <Ban size={12} />
                          <span>{t('guardrails.tripOne')}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', gridColumn: '1 / -1' }}>
              {t('guardrails.noMatch')}
            </div>
          )}
        </div>
        <Pagination
          page={breakerPage}
          pageSize={breakerPageSize}
          total={filteredBreakers.length}
          onChange={setBreakerPage}
          pageSizeOptions={BREAKER_PAGE_SIZES}
          onPageSizeChange={(s) => { setBreakerPageSize(s); setBreakerPage(1); }}
        />
      </div>
    </div>
  );
};
