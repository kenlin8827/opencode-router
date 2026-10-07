import React from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import {
  TrendingDown,
  Zap,
  Cpu,
  Clock,
  ShieldCheck,
  Terminal,
  ArrowRight,
} from 'lucide-react';
import type { GatewayStatusResponse } from '../lib/api';
import { BrandIcon } from '../components/BrandIcons';
import { useI18n } from '../i18n/I18nContext';

export const OverviewPage: React.FC = () => {
  const { status, statusError } = useOutletContext<{ status: GatewayStatusResponse | null; statusError: boolean }>();
  const { t } = useI18n();
  const metrics = status?.metrics;

  const costSaved = metrics?.economics.totalSavingsUsd || 0;
  const savingsPct = metrics?.economics.savingsPct || 0;
  const totalPromptTokens = metrics?.tokens.totalPromptTokens || 0;
  const cachedPromptTokens = metrics?.tokens.totalCachedPromptTokens || 0;
  const cacheHitPct = totalPromptTokens > 0 ? ((cachedPromptTokens / totalPromptTokens) * 100).toFixed(1) : '0.0';
  const totalTokens = (
    totalPromptTokens +
    (metrics?.tokens.totalCompletionTokens || 0) +
    (metrics?.tokens.totalReasoningTokens || 0)
  ).toLocaleString();
  const savedTokens = cachedPromptTokens.toLocaleString();
  const latency = Math.round(metrics?.latency.avgMs || 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Gateway unreachable banner */}
      {statusError && !status && (
        <div
          style={{
            padding: '10px 16px',
            borderRadius: '8px',
            border: '1px solid var(--accent-rose)',
            background: 'rgba(244, 63, 94, 0.08)',
            color: 'var(--accent-rose)',
            fontSize: '13px',
          }}
        >
          {t('overview.statusOffline')}
        </div>
      )}

      {/* 4 Core FinOps Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.costSaved')}</span>
            <TrendingDown size={16} color="var(--accent-emerald)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--accent-emerald)' }}>
            ${costSaved.toFixed(4)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.costSavedSub', { pct: savingsPct.toFixed(1) })}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.cacheHit')}</span>
            <Zap size={16} color="var(--accent)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--accent)' }}>
            {cacheHitPct}%
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.cacheHitSub', { cached: cachedPromptTokens.toLocaleString(), total: totalPromptTokens.toLocaleString() })}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.tokensTotal')}</span>
            <Cpu size={16} color="var(--accent-violet)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--text-main)' }}>
            {totalTokens}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.tokensSaved', { saved: savedTokens })}
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '13px' }}>
            <span>{t('overview.avgLatency')}</span>
            <Clock size={16} color="var(--accent-amber)" />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 4px 0', color: 'var(--text-main)' }}>
            {latency} ms
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('overview.latencySub')}
          </div>
        </div>
      </div>

      {/* 4-Tier Pipeline Topology Architecture */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Zap size={16} />
            <span>{t('overview.pipelineTitle')}</span>
          </div>
          <Link to="/tiers" className="btn btn-sm">
            <span>{t('overview.pipelineBtn')}</span>
            <ArrowRight size={12} />
          </Link>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '14px', borderRadius: '10px', border: '1px solid var(--card-border)' }}>
            <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 700 }}>STAGE 1</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage1')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage1Desc')}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '14px', borderRadius: '10px', border: '1px solid var(--card-border)' }}>
            <div style={{ fontSize: '11px', color: 'var(--accent-emerald)', fontWeight: 700 }}>STAGE 2</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage2')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage2Desc')}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '14px', borderRadius: '10px', border: '1px solid var(--card-border)' }}>
            <div style={{ fontSize: '11px', color: 'var(--accent-violet)', fontWeight: 700 }}>STAGE 3</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage3')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage3Desc')}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '14px', borderRadius: '10px', border: '1px solid var(--card-border)' }}>
            <div style={{ fontSize: '11px', color: 'var(--accent-rose)', fontWeight: 700 }}>STAGE 4</div>
            <div style={{ fontSize: '14px', fontWeight: 600, margin: '4px 0' }}>{t('overview.stage4')}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.stage4Desc')}</div>
          </div>
        </div>
      </div>

      {/* Two Column Section: Client Interception & Circuit Breakers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '20px' }}>
        {/* Clients Hub Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Terminal size={16} />
              <span>{t('overview.clientsCardTitle')}</span>
            </div>
            <Link to="/clients" className="btn btn-sm">{t('overview.manage')}</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {status?.clients?.map(c => (
              <div
                key={c.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--card-border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <BrandIcon name={c.name} size={18} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{c.displayName}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                      {c.configPath}
                    </div>
                  </div>
                </div>
                <div>
                  {c.hooked ? (
                    <span className="badge badge-success">{t('overview.hooked')}</span>
                  ) : (
                    <span className="badge" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)' }}>
                      {t('overview.notHooked')}
                    </span>
                  )}
                </div>
              </div>
            )) || <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>...</div>}
          </div>
        </div>

        {/* Circuit Breakers Card */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <ShieldCheck size={16} />
              <span>{t('overview.breakersCardTitle')}</span>
            </div>
            <Link to="/guardrails" className="btn btn-sm">{t('overview.viewAll')}</Link>
          </div>
          <div style={{ display: 'flex', gap: '16px', marginBottom: '14px' }}>
            <div style={{ flex: 1, padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.totalBreakers')}</div>
              <div style={{ fontSize: '20px', fontWeight: 700 }}>{status?.circuitBreakers?.total || 0}</div>
            </div>
            <div style={{ flex: 1, padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('overview.openBreakers')}</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: status?.circuitBreakers?.tripped ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}>
                {status?.circuitBreakers?.tripped || 0}
              </div>
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
            {t('overview.breakersDesc')}
          </div>
        </div>
      </div>
    </div>
  );
};
