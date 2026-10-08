import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Archive, RefreshCw, Trash2, X, AlertTriangle, Download } from 'lucide-react';
import {
  api,
  type CaptureStatus,
  type CaptureDateRow,
  type CaptureSessionRow,
  type CaptureRecord,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      style={{
        margin: 0,
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--card-border)',
        borderRadius: '6px',
        fontSize: '11px',
        lineHeight: 1.55,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

type DrawerTab = 'reqIn' | 'reqOut' | 'resp';

/**
 * Right-side detail drawer for one captured turn (portal, Esc/overlay close).
 * Tabs keep the three bodies (inbound request / upstream request / response)
 * focused instead of one long scroll — the upstream tab is where you land only
 * when debugging compression/wire behavior, so it defaults to the inbound view.
 */
const CaptureDrawer: React.FC<{
  record: CaptureRecord;
  onClose: () => void;
}> = ({ record, onClose }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<DrawerTab>('reqIn');
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setTab('reqIn'); // reset when switching turns
  }, [record.id]);

  const tabs: { key: DrawerTab; label: string; value: unknown }[] = [
    { key: 'reqIn', label: t('captures.tabReqIn'), value: record.request },
    { key: 'reqOut', label: t('captures.tabReqOut'), value: record.upstreamRequest },
    // Error turns have no success payload — show the verbatim upstream error
    // response (status + body) under the response tab instead.
    { key: 'resp', label: t('captures.tabResp'), value: record.response ?? record.upstreamError },
  ];
  const active = tabs.find(x => x.key === tab)!;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        justifyContent: 'flex-end',
        animation: 'ocr-fade-in 0.15s ease',
      }}
    >
      <div
        className="card"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(760px, 92vw)',
          height: '100vh',
          maxHeight: '100vh',
          borderRadius: 0,
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: 'none',
          display: 'flex',
          flexDirection: 'column',
          animation: 'ocr-slide-in-right 0.18s ease',
        }}
      >
        {/* Header: meta + close */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 16px',
            borderBottom: '1px solid var(--card-border)',
            flexWrap: 'wrap',
          }}
        >
          <span
            className="badge"
            style={
              record.status === 'ok'
                ? { background: 'rgba(16,185,129,0.12)', color: 'var(--accent-emerald)' }
                : { background: 'rgba(239,68,68,0.12)', color: '#ef4444' }
            }
          >
            {record.status === 'ok' ? t('captures.statusOk') : t('captures.statusError')}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
            {new Date(record.ts).toLocaleString()}
          </span>
          <span
            style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}
            title={t('captures.inboundModel')}
          >
            {record.model}
          </span>
          <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>→</span>
          <span
            style={{ fontSize: '12px', fontWeight: 600 }}
            title={t('captures.outboundModel')}
          >
            {record.routing?.provider ? <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>[{record.routing.provider}] </span> : null}
            {record.routing?.modelUsed || record.model}
          </span>
          {record.routing?.tierUsed && (
            <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-dim)' }}>
              {record.routing.tierUsed}
            </span>
          )}
          {record.truncated && (
            <span className="badge" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>
              {t('captures.truncatedBadge')}
            </span>
          )}
          {record.latencyMs !== undefined && (
            <span style={{ fontSize: '12px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
              {record.latencyMs} ms
            </span>
          )}
          <button
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Error banner */}
        {record.error && (
          <div
            style={{
              margin: '12px 16px 0',
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <AlertTriangle size={14} />
            <span>{record.error}</span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '4px', padding: '12px 16px 0', borderBottom: '1px solid var(--card-border)' }}>
          {tabs.map(x => {
            const empty = x.value === undefined || x.value === null;
            return (
              <button
                key={x.key}
                onClick={() => setTab(x.key)}
                title={empty ? t('captures.tabEmpty') : undefined}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: tab === x.key ? '2px solid var(--accent)' : '2px solid transparent',
                  color: tab === x.key ? 'var(--accent)' : 'var(--text-dim)',
                  opacity: empty ? 0.55 : 1,
                  fontSize: '12px',
                  padding: '8px 12px',
                  cursor: 'pointer',
                }}
              >
                {x.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px', minHeight: 0 }}>
          {active.value === undefined || active.value === null ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              {t('captures.tabEmpty')}
            </div>
          ) : (
            <JsonBlock value={active.value} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const CapturesPage: React.FC = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();

  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [dates, setDates] = useState<CaptureDateRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [sessions, setSessions] = useState<CaptureSessionRow[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [records, setRecords] = useState<CaptureRecord[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<CaptureRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [st, ds] = await Promise.all([api.getCaptureStatus(), api.getCaptureDates()]);
      setStatus(st);
      setDates(ds);
      setSelectedDate(prev => (prev && ds.some(d => d.date === prev) ? prev : ds[0]?.date || ''));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadSessions = useCallback(async (date: string) => {
    if (!date) {
      setSessions([]);
      return;
    }
    try {
      const rows = await api.getCaptureSessions(date);
      setSessions(rows);
      setSelectedFile(prev => (prev && rows.some(r => r.file === prev) ? prev : ''));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadRecords = useCallback(async (date: string, file: string) => {
    if (!date || !file) {
      setRecords([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.getCaptureRecords(date, file);
      setRecords(res.records);
      setTotalLines(res.totalLines);
      setFileTruncated(res.fileTruncated);
      setSelectedRecord(null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    loadSessions(selectedDate);
    setSelectedFile('');
    setRecords([]);
  }, [selectedDate, loadSessions]);

  useEffect(() => {
    loadRecords(selectedDate, selectedFile);
  }, [selectedDate, selectedFile, loadRecords]);

  const handleToggle = async (next: boolean) => {
    if (toggling) return;
    // Enabling persists full request/response bodies (potentially sensitive
    // data) — confirm once; disabling is instant and lossless.
    if (next) {
      const ok = await confirmDialog({
        title: t('captures.enableConfirm'),
        danger: false,
        confirmLabel: t('common.confirm'),
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      const cfg = await api.getConfig();
      const res: any = await api.saveConfig({
        ...cfg,
        capture: {
          retentionDays: 7,
          maxTotalMB: 512,
          maxBodyBytes: 65536,
          ...(cfg.capture || {}),
          enabled: next,
        },
      });
      if (res.success !== false) {
        toast.success(t('captures.toggleSaved'));
        await loadStatus();
      } else {
        toast.error(res.error || res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    } finally {
      setToggling(false);
    }
  };

  const handleExport = async (s: CaptureSessionRow) => {
    if (!selectedDate) return;
    try {
      const blob = await api.exportCaptureArchive(selectedDate, s.file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `capture-${selectedDate}-${s.sessionId}.jsonl`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('captures.exported'));
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleDeleteDate = async (date: string) => {
    const ok = await confirmDialog({
      title: t('captures.deleteConfirm').replace('{date}', date),
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    try {
      const res = await api.deleteCaptureDate(date);
      if (res.status === 'ok') {
        toast.success(t('captures.deleted'));
        setSelectedFile('');
        setRecords([]);
        await loadStatus();
      } else {
        toast.error(res.message || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      {/* Archive status, master toggle & retention policy */}
      <div className="card" style={{ flexShrink: 0 }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: '10px' }}>
          <div className="card-title">
            <Archive size={18} color="var(--accent)" />
            <span>{t('captures.title')}</span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
              <span style={{ color: status?.enabled ? 'var(--accent-emerald)' : 'var(--text-dim)' }}>
                {status?.enabled ? t('captures.on') : t('captures.off')}
              </span>
              <Switch
                checked={Boolean(status?.enabled)}
                onChange={handleToggle}
                disabled={toggling || !status}
                ariaLabel={t('captures.title')}
              />
            </label>
            <button className="btn btn-sm" onClick={loadStatus} disabled={loading}>
              <RefreshCw size={12} />
              <span>{t('captures.refresh')}</span>
            </button>
          </div>
        </div>
        <div style={{ padding: '12px 14px', fontSize: '12px' }}>
          {status?.enabled && (
            <div style={{ color: 'var(--text-dim)', marginBottom: '10px' }}>{t('captures.hotHint')}</div>
          )}
          {status && !status.enabled && (
            <div style={{ color: 'var(--text-dim)', lineHeight: 1.8 }}>
              <div>{t('captures.disabledHint')}</div>
            </div>
          )}
          {status && status.enabled && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', color: 'var(--text-muted)' }}>
              <span>
                {t('captures.dir')}: <code style={{ color: 'var(--accent)' }}>{status.dir}</code>
              </span>
              <span>
                {t('captures.retention')}: {status.retentionDays} {t('captures.days')}
              </span>
              <span>
                {t('captures.totalSize')}: {fmtBytes(status.totalBytes)} / {status.maxTotalMB} MB
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Browser: date chips on top → session list (left) + timeline (right) */}
      {status?.enabled && (
        <div
          className="card"
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 0, // edge-to-edge panes below manage their own padding
            overflow: 'hidden', // clip panes to the card radius
          }}
        >
          {dates.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              {t('captures.emptyDates')}
            </div>
          ) : (
            <>
              {/* Date selector row */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--card-border)',
                  flexShrink: 0,
                }}
              >
                {dates.map(d => (
                  <button
                    key={d.date}
                    className="btn btn-sm"
                    onClick={() => setSelectedDate(d.date)}
                    style={
                      d.date === selectedDate
                        ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                        : undefined
                    }
                    title={`${d.sessions} ${t('captures.sessionsUnit')} · ${fmtBytes(d.bytes)}`}
                  >
                    {d.date}
                    <span style={{ marginLeft: '6px', color: 'var(--text-dim)' }}>({d.sessions})</span>
                  </button>
                ))}
                {selectedDate && (
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 'auto', color: '#ef4444' }}
                    onClick={() => handleDeleteDate(selectedDate)}
                  >
                    <Trash2 size={12} />
                    <span>{t('captures.deleteDate')}</span>
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* Left rail: session list of the selected day */}
                <div
                  style={{
                    width: 320,
                    flexShrink: 0,
                    borderRight: '1px solid var(--card-border)',
                    overflowY: 'auto',
                    padding: '4px',
                  }}
                >
                  {sessions.map(s => (
                    <div
                      key={s.file}
                      onClick={() => setSelectedFile(s.file)}
                      title={`${s.sessionId}\n${fmtBytes(s.bytes)}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '7px 10px',
                        marginBottom: '3px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        lineHeight: 1.4,
                        background: s.file === selectedFile ? 'rgba(255,255,255,0.06)' : undefined,
                        borderLeft: s.file === selectedFile ? '2px solid var(--accent)' : '2px solid transparent',
                      }}
                    >
                      {/* Last-turn status dot */}
                      {s.lastStatus && (
                        <span
                          title={s.lastStatus === 'ok' ? t('captures.lastOkTitle') : t('captures.lastErrorTitle')}
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            flexShrink: 0,
                            background: s.lastStatus === 'ok' ? 'var(--accent-emerald)' : '#ef4444',
                            boxShadow: s.lastStatus === 'error' ? '0 0 6px rgba(239,68,68,0.5)' : '0 0 6px rgba(16,185,129,0.4)',
                          }}
                        />
                      )}
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {s.sessionId}
                      </span>
                      <span
                        style={{
                          color: 'var(--text-dim)',
                          fontSize: '11px',
                          fontFamily: 'JetBrains Mono, monospace',
                          flexShrink: 0,
                        }}
                      >
                        {fmtTime(s.mtimeMs)}
                      </span>
                      <span
                        role="button"
                        aria-label={t('captures.exportTitle')}
                        title={t('captures.exportTitle')}
                        onClick={e => {
                          e.stopPropagation();
                          handleExport(s);
                        }}
                        style={{
                          color: 'var(--text-dim)',
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                      >
                        <Download size={13} />
                      </span>
                    </div>
                  ))}
                  {sessions.length === 0 && (
                    <div style={{ padding: '8px', fontSize: '11px', color: 'var(--text-dim)' }}>
                      {t('captures.emptySessions')}
                    </div>
                  )}
                </div>

                {/* Main pane: session timeline */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {!selectedFile ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
                      {t('captures.pickSession')}
                    </div>
                  ) : (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 16px',
                          borderBottom: '1px solid var(--card-border)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: '13px', fontWeight: 600 }}>{t('captures.turnsTitle')}</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--text-dim)' }}>
                          {selectedFile.replace(/\.jsonl$/, '')} · {totalLines} {t('captures.turnsUnit')}
                        </span>
                      </div>
                      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 16px 14px' }}>
                        {fileTruncated && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: '11px',
                              color: '#f59e0b',
                              padding: '4px 0 8px',
                            }}
                          >
                            <AlertTriangle size={12} />
                            <span>{t('captures.fileTruncatedHint')}</span>
                          </div>
                        )}
                        <div style={{ position: 'relative', paddingLeft: 22 }}>
                          {/* Timeline spine */}
                          <div
                            style={{
                              position: 'absolute',
                              left: 4,
                              top: 10,
                              bottom: 10,
                              width: 2,
                              background: 'var(--card-border)',
                              borderRadius: 1,
                            }}
                          />
                          {records.length === 0 && (
                            <div style={{ padding: '18px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
                              {t('captures.emptyRecords')}
                            </div>
                          )}
                          {records.map(r => (
                            <div
                              key={r.id}
                              onClick={() => setSelectedRecord(r)}
                              style={{
                                position: 'relative',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '7px 10px',
                                marginBottom: '2px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '12px',
                              }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              {/* Node dot */}
                              <span
                                style={{
                                  position: 'absolute',
                                  left: -22,
                                  top: 13,
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  background:
                                    r.status === 'ok'
                                      ? 'var(--accent-emerald)'
                                      : '#ef4444',
                                  boxShadow: '0 0 0 2px var(--card-bg)',
                                }}
                              />
                              <span style={{ color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
                                {fmtTime(r.ts)}
                              </span>
                              <span
                                className="badge"
                                style={
                                  r.status === 'ok'
                                    ? { background: 'rgba(16,185,129,0.12)', color: 'var(--accent-emerald)' }
                                    : { background: 'rgba(239,68,68,0.12)', color: '#ef4444' }
                                }
                              >
                                {r.status === 'ok' ? t('captures.statusOk') : t('captures.statusError')}
                              </span>
                              <span
                                style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={`${r.model} → ${r.routing?.provider ? r.routing.provider + '/' : ''}${r.routing?.modelUsed || r.model}`}
                              >
                                {r.routing?.modelUsed && r.routing.modelUsed !== r.model
                                  ? `${r.model} → `
                                  : null}
                                {r.routing?.provider ? <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>[{r.routing.provider}] </span> : null}
                                {r.routing?.modelUsed || r.model}
                              </span>
                              {r.truncated && (
                                <span className="badge" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b', flexShrink: 0 }}>
                                  {t('captures.truncatedBadge')}
                                </span>
                              )}
                              <span
                                style={{
                                  marginLeft: 'auto',
                                  color: 'var(--text-dim)',
                                  fontFamily: 'JetBrains Mono, monospace',
                                  flexShrink: 0,
                                }}
                              >
                                {r.latencyMs !== undefined ? `${r.latencyMs} ms` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {selectedRecord && (
        <CaptureDrawer record={selectedRecord} onClose={() => setSelectedRecord(null)} />
      )}
    </div>
  );
};
