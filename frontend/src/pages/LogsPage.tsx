import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ScrollText, RefreshCw, ArrowDownToLine } from 'lucide-react';
import { api, type LogLine } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { Combobox } from '../components/Combobox';

const LEVEL_COLORS: Record<string, string> = {
  trace: 'var(--text-dim)',
  debug: 'var(--text-dim)',
  info: 'var(--accent)',
  warn: '#f59e0b',
  error: '#ef4444',
  fatal: '#dc2626',
};

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000, 5000];

export const LogsPage: React.FC = () => {
  const { t } = useI18n();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [file, setFile] = useState('');
  const [exists, setExists] = useState(true);
  const [size, setSize] = useState(0);
  const [tail, setTail] = useState(500);
  const [level, setLevel] = useState<string>('');
  const [q, setQ] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getLogs(tail, level || undefined, q || undefined);
      setLines(res.lines);
      setFile(res.file);
      setExists(res.exists);
      setSize(res.size);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [tail, level, q]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = setInterval(loadData, 3000);
    return () => clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const sizeLabel = size > 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} MB`
    : size > 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`;

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="card-header">
        <div className="card-title">
          <ScrollText size={18} color="var(--accent)" />
          <span>{t('logs.title')}</span>
          {exists && (
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', marginLeft: '8px' }}>
              {file} · {sizeLabel}
            </span>
          )}
        </div>
        <button className="btn btn-sm" onClick={loadData} disabled={loading}>
          <RefreshCw size={12} />
          <span>{t('logs.refresh')}</span>
        </button>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '8px', padding: '0 14px 12px 14px', flexWrap: 'wrap', alignItems: 'center' }}>
        <Combobox
          value={level}
          onChange={setLevel}
          options={[
            { value: '', label: t('logs.levelAll') },
            { value: 'info', label: 'INFO+' },
            { value: 'warn', label: 'WARN+' },
            { value: 'error', label: 'ERROR+' },
          ]}
          style={{ fontSize: '12px', padding: '5px 10px', width: '140px' }}
        />
        <Combobox
          value={String(tail)}
          onChange={v => setTail(parseInt(v, 10))}
          options={TAIL_OPTIONS.map(n => ({ value: String(n), label: t('logs.tailLines').replace('{n}', String(n)) }))}
          style={{ fontSize: '12px', padding: '5px 10px', width: '150px' }}
        />
        <input
          type="text"
          className="input"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('logs.searchPlaceholder')}
          style={{ fontSize: '12px', padding: '5px 10px', flex: 1, minWidth: '180px' }}
        />
        <button
          className={`btn btn-sm ${autoScroll ? 'btn-primary' : ''}`}
          onClick={() => setAutoScroll(v => !v)}
          title={t('logs.autoScroll')}
        >
          <ArrowDownToLine size={12} />
          <span>{t('logs.autoScroll')}</span>
        </button>
      </div>

      {/* Body */}
      {!exists ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 14px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
          <div style={{ marginBottom: '6px' }}>{t('logs.noFile')}</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>{file}</div>
        </div>
      ) : (
        <div
          ref={bodyRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.2)',
            borderTop: '1px solid var(--card-border)',
            padding: '8px 0',
          }}
        >
          {lines.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              {t('logs.empty')}
            </div>
          ) : (
            lines.map((line, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  gap: '10px',
                  padding: '2px 14px',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  borderBottom: '1px solid rgba(255,255,255,0.02)',
                }}
              >
                {line.time !== undefined && (
                  <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>
                    {new Date(line.time).toLocaleTimeString('en-US', { hour12: false })}.
                    {String(line.time % 1000).padStart(3, '0')}
                  </span>
                )}
                {line.level && (
                  <span
                    style={{
                      color: LEVEL_COLORS[line.level] || 'var(--text-dim)',
                      fontWeight: 700,
                      minWidth: '44px',
                      flexShrink: 0,
                    }}
                  >
                    {line.level.toUpperCase()}
                  </span>
                )}
                <span style={{ flex: 1, wordBreak: 'break-all', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                  {line.msg ?? line.raw}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
