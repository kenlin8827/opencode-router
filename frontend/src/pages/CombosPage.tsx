import React, { useState, useEffect, useCallback } from 'react';
import { Layers, Plus, Trash2, ArrowUp, ArrowDown, AlertTriangle, Pencil, X, Wand2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { api, opencodeApi, type ComboView, type ComboMemberView } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { Combobox } from '../components/Combobox';

type Selection = 'priority' | 'weighted' | 'round_robin';

/** Virtual model ids routing owns — a combo must never shadow them. */
const RESERVED_COMBO_IDS = new Set(['auto', 'default', 'auto-fast', 'auto-flagship', 'auto-reasoning']);

interface MemberDraft {
  id: string;
  weight: number;
}

interface ComboDraft {
  id: string;
  selection: Selection;
  models: MemberDraft[];
  note: string;
}

/** Config payload → editable draft (members may arrive as strings or {id, weight}). */
const toDraft = (c: ComboView): ComboDraft => ({
  id: c.id,
  selection: (c.selection as Selection) || 'priority',
  models: (c.members || []).map((m: ComboMemberView) => ({ id: m.id, weight: m.weight ?? 1 })),
  note: c.note || '',
});

/** Draft → config payload; weight 1 members serialize as bare strings for readable YAML. */
const toPayload = (d: ComboDraft) => ({
  id: d.id.trim(),
  selection: d.selection,
  ...(d.note.trim() ? { note: d.note.trim() } : {}),
  models: d.models.map(m => (m.weight > 1 ? { id: m.id, weight: m.weight } : m.id)),
});

/** Draft-level validation ('' = valid). Kept in sync between the drawer and card badges. */
const validateDraft = (draft: ComboDraft, all: ComboDraft[], selfIndex: number, modelIds: ReadonlySet<string>): string => {
  const id = draft.id.trim();
  if (!id) return 'combos.warnEmptyId';
  if (RESERVED_COMBO_IDS.has(id)) return 'combos.warnReservedId';
  if (modelIds.has(id)) return 'combos.warnShadowModel';
  if (all.some((c, i) => i !== selfIndex && c.id.trim() === id)) return 'combos.warnDupId';
  if (draft.models.length === 0) return 'combos.warnNoMembers';
  const seen = new Set<string>();
  for (const m of draft.models) {
    if (!m.id) return 'combos.warnEmptyMember';
    if (seen.has(m.id)) return 'combos.warnDupMember';
    seen.add(m.id);
  }
  return '';
};

const BREAKER_DOT_COLOR: Record<string, string> = {
  CLOSED: 'var(--accent-emerald)',
  OPEN: 'var(--accent-rose)',
  HALF_OPEN: 'var(--accent-amber)',
};

/** Breaker-state dot for one member chip on a combo card. */
const HealthDot: React.FC<{ member?: ComboMemberView }> = ({ member }) => {
  if (!member) return null; // unregistered — the chip itself is already styled as a warning
  const color = BREAKER_DOT_COLOR[member.breakerState || 'CLOSED'] || BREAKER_DOT_COLOR.CLOSED;
  return (
    <span
      title={member.breakerState || 'CLOSED'}
      style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }}
    />
  );
};

/** Centered editor dialog for one combo (portal, Esc/backdrop close). */
const ComboDialog: React.FC<{
  draft: ComboDraft;
  isNew: boolean;
  all: ComboDraft[];
  selfIndex: number; // -1 for new
  modelOptions: { value: string; label: string }[];
  /** Every registered physical model id (incl. unconnected providers). */
  registeredIds: ReadonlySet<string>;
  onClose: () => void;
  onSave: (draft: ComboDraft) => Promise<boolean>;
}> = ({ draft, isNew, all, selfIndex, modelOptions, registeredIds, onClose, onSave }) => {
  const { t } = useI18n();
  const toast = useToast();
  const [work, setWork] = useState<ComboDraft>(draft);
  const [pattern, setPattern] = useState('');
  const [saving, setSaving] = useState(false);
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const warn = validateDraft(work, all, selfIndex, registeredIds);
  const patch = (p: Partial<ComboDraft>) => setWork(prev => ({ ...prev, ...p }));
  const patchMember = (idx: number, p: Partial<MemberDraft>) =>
    setWork(prev => ({ ...prev, models: prev.models.map((m, i) => (i === idx ? { ...m, ...p } : m)) }));
  const moveMember = (idx: number, dir: -1 | 1) =>
    setWork(prev => {
      const next = [...prev.models];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...prev, models: next };
    });

  /** Expand a '*' wildcard pattern over connected registered models → new members. */
  const addByPattern = () => {
    const p = pattern.trim();
    if (!p) return;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`^${p.split('*').map(esc).join('.*')}$`, 'i');
    const existing = new Set(work.models.map(m => m.id));
    const add = modelOptions.filter(o => rx.test(o.value) && !existing.has(o.value));
    if (add.length === 0) {
      toast.error(t('combos.patternNoMatch'));
      return;
    }
    patch({ models: [...work.models, ...add.map(o => ({ id: o.value, weight: 1 }))] });
    setPattern('');
    toast.success(t('combos.patternAdded', { count: add.length }));
  };

  const handleSave = async () => {
    if (warn || saving) return;
    setSaving(true);
    const ok = await onSave(work);
    setSaving(false);
    if (ok) onClose();
  };

  // Close on backdrop click only when BOTH press and release happen on the
  // overlay itself — a click that starts inside the form and ends on the
  // overlay (text-selection drag) must not dismiss the dialog.
  const mouseDownOnOverlay = React.useRef(false);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        overflowY: 'auto',
        padding: '16px',
        animation: 'ocr-fade-in 0.15s ease',
      }}
      onMouseDown={e => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={e => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          margin: 'auto',
          width: '100%',
          maxWidth: 640,
          maxHeight: '85vh',
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'ocr-pop-in 0.18s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 16px',
            borderBottom: '1px solid var(--card-border)',
          }}
        >
          <Layers size={16} color="var(--accent)" />
          <span style={{ fontSize: '14px', fontWeight: 600 }}>
            {isNew ? t('combos.newCombo') : `${t('combos.edit')} · ${draft.id || '…'}`}
          </span>
          <button className="btn btn-sm" style={{ marginLeft: 'auto', padding: '4px 6px' }} onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('combos.comboId')}
            </label>
            <input
              type="text"
              placeholder={t('combos.comboIdPlaceholder')}
              value={work.id}
              onChange={e => patch({ id: e.target.value })}
              className="input"
              style={{ fontFamily: 'monospace' }}
            />
          </div>

          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('combos.selection')}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['priority', 'weighted', 'round_robin'] as Selection[]).map(s => (
                <button
                  key={s}
                  type="button"
                  className={work.selection === s ? 'btn btn-primary' : 'btn'}
                  style={{ fontSize: '12px', flex: 1 }}
                  onClick={() => patch({ selection: s })}
                >
                  {t(s === 'priority' ? 'combos.selPriority' : s === 'weighted' ? 'combos.selWeighted' : 'combos.selRoundRobin')}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px', display: 'block' }}>
              {t('combos.members')}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {work.models.map((member, mIdx) => {
                const known = registeredIds.has(member.id);
                return (
                  <div key={mIdx} style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)', width: '18px', textAlign: 'right' }}>
                      {mIdx + 1}.
                    </span>
                    <Combobox
                      value={member.id}
                      onChange={v => patchMember(mIdx, { id: v })}
                      options={modelOptions}
                      placeholder={t('combos.memberPlaceholder')}
                      panelMinWidth={360}
                      style={{ fontSize: '12px', padding: '5px 10px', flex: 1, minWidth: '220px' }}
                    />
                    {work.selection !== 'priority' && (
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-dim)' }}
                      >
                        {t('combos.weight')}
                        <input
                          type="number"
                          min={1}
                          value={member.weight}
                          onChange={e => patchMember(mIdx, { weight: Math.max(1, Number(e.target.value) || 1) })}
                          className="input"
                          style={{ width: '60px', padding: '4px 6px' }}
                        />
                      </label>
                    )}
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        className="btn btn-sm"
                        style={{ padding: '4px 6px' }}
                        disabled={mIdx === 0}
                        onClick={() => moveMember(mIdx, -1)}
                        title={t('combos.moveUp')}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        className="btn btn-sm"
                        style={{ padding: '4px 6px' }}
                        disabled={mIdx === work.models.length - 1}
                        onClick={() => moveMember(mIdx, 1)}
                        title={t('combos.moveDown')}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        style={{ padding: '4px 6px' }}
                        onClick={() => patch({ models: work.models.filter((_, j) => j !== mIdx) })}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {!known && member.id && (
                      <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--accent-rose)' }}>
                        <AlertTriangle size={12} />
                        <span>{t('combos.unregisteredWarn')}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  className="input"
                  style={{ flex: 1, fontSize: '12px', fontFamily: 'monospace' }}
                  placeholder={t('combos.patternPlaceholder')}
                  value={pattern}
                  onChange={e => setPattern(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addByPattern();
                    }
                  }}
                />
                <button
                  className="btn btn-sm"
                  style={{ gap: '6px', whiteSpace: 'nowrap' }}
                  onClick={addByPattern}
                  disabled={!pattern.trim()}
                >
                  <Wand2 size={14} />
                  <span>{t('combos.patternAdd')}</span>
                </button>
              </div>
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start', gap: '6px' }}
                onClick={() => patch({ models: [...work.models, { id: '', weight: 1 }] })}
              >
                <Plus size={14} />
                <span>{t('combos.addMember')}</span>
              </button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('combos.noteLabel')}
            </label>
            <textarea
              className="input"
              rows={2}
              placeholder={t('combos.notePlaceholder')}
              value={work.note}
              onChange={e => patch({ note: e.target.value })}
              style={{ fontSize: '12px', resize: 'vertical' }}
            />
          </div>

          {warn && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--accent-rose)' }}>
              <AlertTriangle size={13} />
              <span>{t(warn)}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            padding: '12px 16px',
            borderTop: '1px solid var(--card-border)',
          }}
        >
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!!warn || saving}>
            {t('combos.saveBtn')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export const CombosPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [combos, setCombos] = useState<ComboDraft[] | null>(null);
  // Introspection meta by combo id (active flag + member registered/tier/
  // breaker state) for card rendering.
  const [meta, setMeta] = useState<Record<string, ComboView>>({});
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  // Every registered physical model id (incl. unconnected providers) — used to
  // tell "unregistered" apart from "provider offline" for existing members.
  const [registeredIds, setRegisteredIds] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ draft: ComboDraft; index: number } | null>(null); // index -1 = new
  const [saving, setSaving] = useState(false);

  const refreshMeta = useCallback(() => {
    api
      .getCombos()
      .then(res => {
        const next: Record<string, ComboView> = {};
        for (const c of res.combos || []) next[c.id] = c;
        setMeta(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([api.getCombos(), api.listGatewayModels(), opencodeApi.listProviders()])
      .then(([comboRes, models, provRes]) => {
        const byId: Record<string, ComboView> = {};
        for (const c of comboRes.combos || []) byId[c.id] = c;
        setMeta(byId);
        setCombos((comboRes.combos || []).map(toDraft));
        // Registered physical models only (/v1/models also lists virtual auto-*
        // entries and combos); picker candidates are further narrowed to
        // providers whose auth is connected — an unconnected provider cannot
        // serve requests, so its models make no sense as combo members.
        const registered = models.filter(m => m.tier);
        const connected = new Set((provRes.providers || []).filter(p => p.auth?.connected).map(p => p.id));
        setRegisteredIds(new Set(registered.map(m => m.id)));
        setModelOptions(registered.filter(m => connected.has(m.owned_by)).map(m => ({ value: m.id, label: m.id })));
      })
      .catch(err => {
        console.error('Failed to load combos:', err);
        setCombos([]);
      });
  }, []);

  /** Persist the whole combos list (server merges the section + hot-applies). */
  const persist = useCallback(
    async (next: ComboDraft[]) => {
      setSaving(true);
      try {
        await api.saveConfig({ combos: next.map(toPayload) });
        toast.success(t('combos.savedNotice'));
        refreshMeta();
        return true;
      } catch (err: any) {
        toast.error('Failed: ' + err.message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refreshMeta, t, toast]
  );

  const handleDrawerSave = useCallback(
    async (draft: ComboDraft): Promise<boolean> => {
      if (!combos) return false;
      const next = [...combos];
      if (editing && editing.index >= 0) next[editing.index] = draft;
      else next.push(draft);
      setCombos(next); // optimistic commit; revert on failure keeps the drawer state coherent
      const ok = await persist(next);
      if (!ok) setCombos(combos);
      return ok;
    },
    [combos, editing, persist]
  );

  const handleDelete = useCallback(
    async (idx: number) => {
      if (!combos) return;
      const target = combos[idx];
      const ok = await confirmDialog({
        title: t('combos.deleteTitle'),
        description: target.id,
        danger: true,
      });
      if (!ok) return;
      const next = combos.filter((_, i) => i !== idx);
      setCombos(next);
      const saved = await persist(next);
      if (!saved) setCombos(combos);
    },
    [combos, persist, t, confirmDialog]
  );

  if (combos === null) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Layers size={18} color="var(--accent)" />
          <span>{t('combos.title')}</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setEditing({ draft: { id: '', selection: 'priority', models: [{ id: '', weight: 1 }], note: '' }, index: -1 })}
        >
          <Plus size={14} />
          <span>{t('combos.addCombo')}</span>
        </button>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '16px' }}>
        {t('combos.hint')}
      </div>

      {combos.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--text-dim)', padding: '16px 0' }}>{t('combos.empty')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '14px' }}>
          {combos.map((combo, idx) => {
            const comboMeta = meta[combo.id.trim()];
            const membersMeta = comboMeta?.members || [];
            const inactive = comboMeta ? comboMeta.active === false : false;
            const modelIds = registeredIds;
            const warn = validateDraft(combo, combos, idx, modelIds);
            return (
              <div
                key={idx}
                className="card"
                onClick={() => setEditing({ draft: { ...combo, models: combo.models.map(m => ({ ...m })) }, index: idx })}
                style={{
                  padding: '14px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  margin: 0,
                  borderColor: warn || inactive ? 'var(--accent-rose)' : undefined,
                }}
              >
                {/* Card head: id + strategy badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 600, wordBreak: 'break-all' }}>
                    {combo.id.trim() || <span style={{ color: 'var(--accent-rose)' }}>—</span>}
                  </span>
                  {inactive && (
                    <span
                      title={t('combos.inactiveWarn')}
                      style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '10px', color: 'var(--accent-rose)', border: '1px solid var(--accent-rose)', whiteSpace: 'nowrap' }}
                    >
                      {t('combos.inactiveBadge')}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: '10px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      border: '1px solid var(--card-border)',
                      color: 'var(--text-dim)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t(`combos.sel${combo.selection.charAt(0).toUpperCase()}${combo.selection.slice(1)}`)}
                  </span>
                </div>

                {combo.note.trim() && (
                  <div
                    title={combo.note}
                    style={{ fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {combo.note}
                  </div>
                )}

                {/* Member chips (failover chain order) */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {combo.models.map((m, mIdx) => {
                    const mm = membersMeta.find(x => x.id === m.id);
                    const unregistered = m.id && mm && !mm.registered;
                    return (
                      <div
                        key={mIdx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '7px',
                          fontSize: '12px',
                          padding: '5px 8px',
                          borderRadius: '6px',
                          background: 'var(--bg-elev, rgba(255,255,255,0.03))',
                          border: unregistered ? '1px dashed var(--accent-rose)' : '1px solid transparent',
                        }}
                      >
                        <span style={{ color: 'var(--text-dim)', fontSize: '10px', width: '14px' }}>{mIdx + 1}</span>
                        <HealthDot member={mm} />
                        <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.id || <span style={{ color: 'var(--accent-rose)' }}>{t('combos.warnEmptyMember')}</span>}
                        </span>
                        {combo.selection !== 'priority' && (m.weight ?? 1) > 1 && (
                          <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--text-dim)' }}>×{m.weight}</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Card foot: count + actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                    {combo.models.length} {t('combos.membersUnit')}
                  </span>
                  {warn && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--accent-rose)' }}>
                      <AlertTriangle size={11} />
                      <span>{t(warn)}</span>
                    </span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-sm"
                      style={{ padding: '4px 8px' }}
                      title={t('combos.edit')}
                      onClick={e => {
                        e.stopPropagation();
                        setEditing({ draft: { ...combo, models: combo.models.map(m => ({ ...m })) }, index: idx });
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ padding: '4px 8px' }}
                      onClick={e => {
                        e.stopPropagation();
                        void handleDelete(idx);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ComboDialog
          draft={editing.draft}
          isNew={editing.index < 0}
          all={combos}
          selfIndex={editing.index}
          modelOptions={modelOptions}
          registeredIds={registeredIds}
          onClose={() => setEditing(null)}
          onSave={handleDrawerSave}
        />
      )}
    </div>
  );
};
