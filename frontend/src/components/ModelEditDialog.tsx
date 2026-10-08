import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Plus, Loader2, Wand2 } from 'lucide-react';
import { opencodeApi } from '../lib/api';
import { matchCatalogModel, catalogAutofillPatch, detectEffortLevel } from '../lib/catalogAutofill';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Combobox } from '../components/Combobox';
import { Switch } from './Switch';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

/** Backdrop blur is opt-in per dialog (default: dim only, no blur). */
const overlayStyle = (blur: boolean): React.CSSProperties => ({
  position: 'fixed',
  inset: 0,
  zIndex: 210,
  background: 'rgba(0, 0, 0, 0.75)',
  backdropFilter: blur ? 'blur(8px)' : undefined,
  display: 'flex',
  overflowY: 'auto',
  padding: '16px',
  animation: 'ocr-fade-in 0.15s ease',
});

const dialogStyle: React.CSSProperties = {
  margin: 'auto',
  width: '100%',
  maxWidth: 520,
  maxHeight: '85vh',
  overflow: 'hidden',
  padding: '20px',
  boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  animation: 'ocr-pop-in 0.18s ease',
};

const formBodyStyle: React.CSSProperties = {
  overflowY: 'auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  paddingRight: 2,
};

const formFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  paddingTop: 10,
  borderTop: '1px solid var(--card-border)',
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-dim)',
  display: 'block',
  marginBottom: 4,
};

const MODALITY_OPTIONS = ['text', 'image', 'audio', 'video', 'pdf'] as const;
const EFFORT_OPTIONS = ['', 'minimal', 'low', 'medium', 'high'] as const;

interface ModelFormState {
  modelKey: string;
  name: string;
  modelID: string;
  disabled: boolean;
  tools: boolean;
  inputMod: string[];
  outputMod: string[];
  contextLimit: string;
  outputLimit: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
  reasoningEffort: string;
  headersText: string;
  bodyText: string;
  reasoningField: string;
  variants: { id: string; effort: string }[];
}

const defTools = (d: any): boolean => d?.capabilities?.tools ?? d?.tool_call === true;
const defInput = (d: any): string[] => d?.capabilities?.input ?? d?.modalities?.input ?? [];
const defOutput = (d: any): string[] => d?.capabilities?.output ?? d?.modalities?.output ?? [];

const formFromDef = (modelKey: string, d: any): ModelFormState => ({
  modelKey,
  name: d?.name || '',
  modelID: d?.modelID || '',
  disabled: d?.disabled === true,
  tools: defTools(d),
  inputMod: defInput(d).length ? [...defInput(d)] : ['text'],
  outputMod: defOutput(d).length ? [...defOutput(d)] : ['text'],
  contextLimit: d?.limit?.context ? String(d.limit.context) : '',
  outputLimit: d?.limit?.output ? String(d.limit.output) : '',
  costInput: typeof d?.cost?.input === 'number' ? String(d.cost.input) : '',
  costOutput: typeof d?.cost?.output === 'number' ? String(d.cost.output) : '',
  costCacheRead: typeof d?.cost?.cache_read === 'number' ? String(d.cost.cache_read) : '',
  costCacheWrite: typeof d?.cost?.cache_write === 'number' ? String(d.cost.cache_write) : '',
  reasoningEffort: d?.settings?.reasoningEffort || '',
  headersText: Object.entries(d?.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n'),
  bodyText: d?.body && Object.keys(d.body).length > 0 ? JSON.stringify(d.body, null, 2) : '',
  reasoningField: d?.compatibility?.reasoningField || '',
  variants: Array.isArray(d?.variants)
    ? d.variants.map((v: any) => ({ id: v.id || '', effort: v.settings?.reasoningEffort || '' }))
    : [],
});

/**
 * Self-contained single-model editor (opencode v2 schema): fetches the model's
 * current definition from opencode.jsonc, edits it in place, PATCHes back.
 * Used from the /models page rows of config-defined models.
 */
export const ModelEditDialog: React.FC<{
  providerId: string;
  modelId: string;
  blur?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}> = ({ providerId, modelId, blur = false, onClose, onSaved }) => {
  const { t } = useI18n();
  const toast = useToast();
  useBodyScrollLock(true);

  const [form, setForm] = useState<ModelFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filling, setFilling] = useState(false);

  /** Auto-fill blank form fields from the best catalog match (never overwrites entered values). */
  const handleAutofill = async () => {
    if (!form) return;
    const want = form.modelID.trim() || form.modelKey.trim();
    if (!want) {
      toast.info(t('op.pmAutofillNoId'));
      return;
    }
    setFilling(true);
    try {
      const hit = await matchCatalogModel(providerId, form.modelID, form.modelKey);
      if (!hit) {
        toast.info(t('op.pmAutofillNone', { id: want }));
        return;
      }
      const m = hit.model;
      const p = catalogAutofillPatch(m);
      const effort = detectEffortLevel([form.modelID, form.modelKey]);
      setForm((prev) => {
        if (!prev) return prev;
        const d = { ...prev };
        const isDefaultMod = (a: string[]) => a.length === 1 && a[0] === 'text';
        if (!d.name && p.name) d.name = p.name;
        if (!d.contextLimit && p.contextLimit) d.contextLimit = p.contextLimit;
        if (!d.outputLimit && p.outputLimit) d.outputLimit = p.outputLimit;
        if (!d.costInput && p.costInput) d.costInput = p.costInput;
        if (!d.costOutput && p.costOutput) d.costOutput = p.costOutput;
        if (!d.costCacheRead && p.costCacheRead) d.costCacheRead = p.costCacheRead;
        if (!d.costCacheWrite && p.costCacheWrite) d.costCacheWrite = p.costCacheWrite;
        if (isDefaultMod(d.inputMod) && p.inputMod) d.inputMod = [...p.inputMod];
        if (isDefaultMod(d.outputMod) && p.outputMod) d.outputMod = [...p.outputMod];
        // reasoning effort encoded in the id itself ('...-high') — fill when unset
        if (!d.reasoningEffort && effort) d.reasoningEffort = effort;
        return d;
      });
      const matchedId = `${m.providerId}/${m.id}`;
      toast.success(
        hit.alternatives > 1
          ? t('op.pmAutofillAmbiguous', { n: hit.alternatives, id: matchedId })
          : t('op.pmAutofillMatched', { id: matchedId })
      );
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setFilling(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await opencodeApi.listProviderModels(providerId);
        const d = (res.models || {})[modelId];
        if (!d) throw new Error(`Model '${modelId}' not found for provider '${providerId}'`);
        setForm(formFromDef(modelId, d));
      } catch (err: any) {
        toast.error(err.message);
        onClose();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, modelId]);

  const handleSave = async () => {
    if (!form) return;
    const f = form;
    const modalities =
      f.inputMod.length > 0 || f.outputMod.length > 0
        ? { input: f.inputMod.length > 0 ? f.inputMod : undefined, output: f.outputMod.length > 0 ? f.outputMod : undefined }
        : {};
    const payload: any = {
      name: f.name.trim() || undefined,
      modelID: f.modelID.trim() || undefined,
      disabled: f.disabled,
      capabilities: { tools: f.tools, input: f.inputMod, output: f.outputMod },
      settings: f.reasoningEffort ? { reasoningEffort: f.reasoningEffort } : {},
      headersText: f.headersText,
      bodyText: f.bodyText,
      compatibility: f.reasoningField.trim() ? { reasoningField: f.reasoningField.trim() } : {},
      variants: f.variants.filter((v) => v.id.trim()).map((v) => ({ id: v.id.trim(), settings: v.effort ? { reasoningEffort: v.effort } : undefined })),
      contextLimit: f.contextLimit ? Number(f.contextLimit) : undefined,
      outputLimit: f.outputLimit ? Number(f.outputLimit) : undefined,
      newId: f.modelKey.trim() && f.modelKey.trim() !== modelId ? f.modelKey.trim() : undefined,
    };
    // cost ($/1M): always sent — the backend treats a present `cost` key as
    // full replace, so blanking a field clears the stored value. Invalid
    // input (non-numeric / negative) is dropped, i.e. treated as blank.
    const cost: Record<string, number> = {};
    const costNum = (s: string): number | undefined => {
      const t = s.trim();
      if (!t) return undefined;
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const cIn = costNum(f.costInput);
    const cOut = costNum(f.costOutput);
    const cRead = costNum(f.costCacheRead);
    const cWrite = costNum(f.costCacheWrite);
    if (cIn !== undefined) cost.input = cIn;
    if (cOut !== undefined) cost.output = cOut;
    if (cRead !== undefined) cost.cache_read = cRead;
    if (cWrite !== undefined) cost.cache_write = cWrite;
    payload.cost = cost;
    if (!payload.capabilities.tools && payload.capabilities.input.length === 0 && payload.capabilities.output.length === 0) {
      payload.capabilities = {};
    }
    try {
      if (f.bodyText.trim()) JSON.parse(f.bodyText);
    } catch {
      toast.error(t('op.pmBodyInvalid'));
      return;
    }
    setSaving(true);
    try {
      await opencodeApi.updateProviderModel(providerId, modelId, payload);
      onSaved?.();
      onClose();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const modalityChecks = (key: 'inputMod' | 'outputMod') => (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {MODALITY_OPTIONS.map((m) => (
        <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form![key].includes(m)}
            onChange={(e) =>
              setForm({
                ...form!,
                [key]: e.target.checked ? [...form![key], m] : (form![key] as string[]).filter((x) => x !== m),
              })
            }
          />
          {modLabel(m)}
        </label>
      ))}
    </div>
  );

  const modLabel = (m: string): string => {
    const key = `models.mod${m.charAt(0).toUpperCase()}${m.slice(1)}`;
    try {
      const v = t(key as any);
      return v && v !== key ? v : m;
    } catch {
      return m;
    }
  };

  const spin: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

  // Close on backdrop click only when BOTH press and release happen on the
  // overlay itself — a click that starts inside the form and ends on the
  // overlay (text-selection drag) must not dismiss the dialog.
  const mouseDownOnOverlay = React.useRef(false);

  return createPortal(
    <div
      style={overlayStyle(blur)}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={dialogStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{t('op.pmEditTitle')}</span>
          <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-dim)' }}>{providerId}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <button
              className="btn btn-sm"
              title={t('op.pmAutofillTip')}
              disabled={filling}
              onClick={handleAutofill}
              style={{ display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px' }}
            >
              {filling ? <Loader2 size={13} style={spin} /> : <Wand2 size={13} />}
              <span style={{ fontSize: 11 }}>{t('op.pmAutofill')}</span>
            </button>
            <button className="btn btn-sm" style={{ display: 'flex', alignItems: 'center', height: 24, padding: '0 6px' }} onClick={onClose}>
              <X size={13} />
            </button>
          </div>
        </div>

        {loading || !form ? (
          <div style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
            <Loader2 size={14} style={{ ...spin, marginRight: 6 }} />
            {t('common.loading')}
          </div>
        ) : (
          <>
            <div style={formBodyStyle}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmAddId')}</label>
                  <input className="input" style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', width: '100%' }} value={form.modelKey} onChange={(e) => setForm({ ...form, modelKey: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmEditName')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && handleSave()} />
                </div>
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmModelID')}</label>
                <input className="input" style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', width: '100%' }} placeholder="gpt-5.2" value={form.modelID} onChange={(e) => setForm({ ...form, modelID: e.target.value })} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  <Switch size="sm" checked={form.tools} onChange={(v) => setForm({ ...form, tools: v })} />
                  {t('models.badgeToolCall')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  <Switch size="sm" checked={form.disabled} onChange={(v) => setForm({ ...form, disabled: v })} />
                  {t('op.pmDisabled')}
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center' }}>
                <span style={fieldLabelStyle}>{t('models.modalitiesInput')}</span>
                {modalityChecks('inputMod')}
                <span style={fieldLabelStyle}>{t('models.modalitiesOutput')}</span>
                {modalityChecks('outputMod')}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmEditContext')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" placeholder="200000" value={form.contextLimit} onChange={(e) => setForm({ ...form, contextLimit: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmEditOutput')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" placeholder="64000" value={form.outputLimit} onChange={(e) => setForm({ ...form, outputLimit: e.target.value })} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmCostInput')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="3.00" value={form.costInput} onChange={(e) => setForm({ ...form, costInput: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmCostOutput')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="15.00" value={form.costOutput} onChange={(e) => setForm({ ...form, costOutput: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmCostCacheRead')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="0.30" value={form.costCacheRead} onChange={(e) => setForm({ ...form, costCacheRead: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabelStyle}>{t('op.pmCostCacheWrite')}</label>
                  <input className="input" style={{ fontSize: 12, width: '100%' }} type="number" step="any" min="0" placeholder="3.75" value={form.costCacheWrite} onChange={(e) => setForm({ ...form, costCacheWrite: e.target.value })} />
                </div>
              </div>

              <div>
                <label style={fieldLabelStyle}>{t('op.pmSettingsReasoning')}</label>
                <Combobox
                  style={{ fontSize: 12, width: '100%', cursor: 'pointer' }}
                  value={form.reasoningEffort}
                  onChange={(v) => setForm({ ...form, reasoningEffort: v })}
                  options={EFFORT_OPTIONS.map((o) => ({ value: o, label: o || t('op.pmUnset') }))}
                />
              </div>

              <div>
                <label style={fieldLabelStyle}>{t('op.pmVariants')}</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {form.variants.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6 }}>
                      <input className="input" style={{ fontSize: 11.5, flex: 1, fontFamily: 'JetBrains Mono, monospace' }} placeholder="fast" value={v.id} onChange={(e) => { const variants = [...form.variants]; variants[i] = { ...v, id: e.target.value }; setForm({ ...form, variants }); }} />
                      <Combobox
                        style={{ fontSize: 11.5, width: 110, cursor: 'pointer' }}
                        value={v.effort}
                        onChange={(effort) => { const variants = [...form.variants]; variants[i] = { ...v, effort }; setForm({ ...form, variants }); }}
                        options={EFFORT_OPTIONS.map((o) => ({ value: o, label: o || t('op.pmUnset') }))}
                      />
                      <button className="btn btn-sm" style={{ padding: '3px 6px' }} onClick={() => setForm({ ...form, variants: form.variants.filter((_, j) => j !== i) })}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn btn-sm"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => setForm({ ...form, variants: [...form.variants, { id: '', effort: '' }] })}
                  >
                    <Plus size={11} />
                    <span>{t('op.pmAdd')}</span>
                  </button>
                </div>
              </div>

              <div>
                <label style={fieldLabelStyle}>{t('op.pmReasoningField')}</label>
                <input className="input" style={{ fontSize: 12, width: '100%', fontFamily: 'JetBrains Mono, monospace' }} placeholder="reasoning_content" list="ocr-reasoning-fields-m" value={form.reasoningField} onChange={(e) => setForm({ ...form, reasoningField: e.target.value })} />
                <datalist id="ocr-reasoning-fields-m">
                  <option value="reasoning" />
                  <option value="reasoning_content" />
                  <option value="reasoning_text" />
                </datalist>
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmHeaders')}</label>
                <textarea className="input" style={{ fontSize: 11.5, width: '100%', minHeight: 44, fontFamily: 'JetBrains Mono, monospace', resize: 'vertical' }} placeholder={'X-Team: platform'} value={form.headersText} onChange={(e) => setForm({ ...form, headersText: e.target.value })} />
              </div>
              <div>
                <label style={fieldLabelStyle}>{t('op.pmBody')}</label>
                <textarea className="input" style={{ fontSize: 11.5, width: '100%', minHeight: 44, fontFamily: 'JetBrains Mono, monospace', resize: 'vertical' }} placeholder={'{ "store": false }'} value={form.bodyText} onChange={(e) => setForm({ ...form, bodyText: e.target.value })} />
              </div>
            </div>

            <div style={formFooterStyle}>
              <button className="btn" onClick={onClose}>
                {t('op.pmCancel')}
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
                {saving ? <Loader2 size={12} style={spin} /> : <Check size={12} />}
                <span>{t('op.pmSave')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
