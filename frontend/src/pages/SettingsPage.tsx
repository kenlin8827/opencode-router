import React, { useState, useEffect } from 'react';
import { Sliders, Save, Check, Globe, HardDrive, Orbit } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';

export const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    api.getConfig().then(data => {
      setConfig(data);
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleSave = async () => {
    try {
      await api.saveConfig(config);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  if (loading || !config) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Sliders size={18} color="var(--accent)" />
            <span>{t('settings.title')}</span>
          </div>
          <button className="btn btn-primary" onClick={handleSave}>
            <Save size={14} />
            <span>{t('settings.saveBtn')}</span>
          </button>
        </div>

        {savedNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{t('settings.savedNotice')}</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
          {/* Section 1: Server & Network */}
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '10px', border: '1px solid var(--card-border)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Globe size={14} />
              {t('settings.netTitle')}
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.port')}</label>
              <input
                type="number"
                value={config.port || 3000}
                onChange={e => setConfig({ ...config, port: parseInt(e.target.value) || 3000 })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.host')}</label>
              <input
                type="text"
                value={config.host || '0.0.0.0'}
                onChange={e => setConfig({ ...config, host: e.target.value })}
                className="input"
              />
            </div>
          </div>

          {/* Section 2: Semantic Cache */}
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '10px', border: '1px solid var(--card-border)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <HardDrive size={14} />
              {t('settings.cacheTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.cacheEnable')}</span>
              <Switch
                checked={config.cache?.enabled ?? true}
                onChange={v => setConfig({ ...config, cache: { ...config.cache, enabled: v } })}
              />
            </label>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.cacheSim')}</label>
              <input
                type="number"
                step="0.05"
                value={config.cache?.similarityThreshold || 0.85}
                onChange={e => setConfig({ ...config, cache: { ...config.cache, similarityThreshold: parseFloat(e.target.value) || 0.85 } })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.cacheTtl')}</label>
              <input
                type="number"
                value={config.cache?.ttlSeconds || 3600}
                onChange={e => setConfig({ ...config, cache: { ...config.cache, ttlSeconds: parseInt(e.target.value) || 3600 } })}
                className="input"
              />
            </div>
          </div>

          {/* Section 3: Data Flywheel */}
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '10px', border: '1px solid var(--card-border)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Orbit size={14} />
              {t('settings.flywheelTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.flywheelEnable')}</span>
              <Switch
                checked={config.flywheel?.enabled ?? true}
                onChange={v => setConfig({ ...config, flywheel: { ...config.flywheel, enabled: v } })}
              />
            </label>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.flywheelPath')}</label>
              <input
                type="text"
                value={config.flywheel?.datasetPath || './data/flywheel.jsonl'}
                onChange={e => setConfig({ ...config, flywheel: { ...config.flywheel, datasetPath: e.target.value } })}
                className="input"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
