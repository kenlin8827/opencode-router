import React, { useState, useEffect } from 'react';
import { ArrowLeftRight, Save, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';

interface ProxyShape {
  enabled?: boolean;
  url?: string;
  whitelist?: string[];
  blacklist?: string[];
}

/** Editable list of glob patterns (one input per row) — shared by whitelist/blacklist. */
const PatternListEditor: React.FC<{
  label: string;
  placeholder: string;
  addLabel: string;
  patterns: string[];
  onChange: (patterns: string[]) => void;
}> = ({ label, placeholder, addLabel, patterns, onChange }) => (
  <div>
    <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{label}</label>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {patterns.map((p, idx) => (
        <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder={placeholder}
            value={p || ''}
            onChange={e => {
              const next = [...patterns];
              next[idx] = e.target.value;
              onChange(next);
            }}
            className="input"
          />
          <button
            className="btn btn-danger btn-sm"
            style={{ padding: '4px 8px' }}
            onClick={() => onChange(patterns.filter((_, i) => i !== idx))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        className="btn btn-sm"
        style={{ alignSelf: 'flex-start', gap: '6px' }}
        onClick={() => onChange([...patterns, ''])}
      >
        <Plus size={14} />
        <span>{addLabel}</span>
      </button>
    </div>
  </div>
);

export const ProxyPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [proxy, setProxy] = useState<ProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getConfig().then(cfg => {
      setProxy(((cfg as any).proxy as ProxyShape) || {});
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveConfig({ proxy });
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !proxy) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <ArrowLeftRight size={18} color="var(--accent)" />
          <span>{t('proxy.title')}</span>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          <Save size={14} />
          <span>{t('proxy.saveBtn')}</span>
        </button>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '16px' }}>
        {t('proxy.hint')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '640px' }}>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
          <span>{t('proxy.enable')}</span>
          <Switch
            checked={proxy.enabled ?? false}
            onChange={v => setProxy({ ...proxy, enabled: v })}
          />
        </label>

        <div>
          <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('proxy.url')}</label>
          <input
            type="text"
            placeholder="http://user:pass@127.0.0.1:7890"
            value={proxy.url || ''}
            onChange={e => setProxy({ ...proxy, url: e.target.value })}
            className="input"
          />
        </div>

        <PatternListEditor
          label={t('proxy.whitelist')}
          placeholder={t('proxy.pattern')}
          addLabel={t('proxy.addPattern')}
          patterns={proxy.whitelist || []}
          onChange={patterns => setProxy({ ...proxy, whitelist: patterns })}
        />

        <PatternListEditor
          label={t('proxy.blacklist')}
          placeholder={t('proxy.pattern')}
          addLabel={t('proxy.addPattern')}
          patterns={proxy.blacklist || []}
          onChange={patterns => setProxy({ ...proxy, blacklist: patterns })}
        />
      </div>
    </div>
  );
};
