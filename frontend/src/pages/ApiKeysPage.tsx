import React, { useState, useEffect } from 'react';
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { api, type ApiKeyItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';
import { Combobox } from '../components/Combobox';
import { Pagination } from '../components/Pagination';

const KEY_PAGE_SIZE = 20;
const KEY_PAGE_SIZES = [10, 20, 50, 100, 200];

export const ApiKeysPage: React.FC = () => {
  const { t } = useI18n();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

  // Create modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formName, setFormName] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formRole, setFormRole] = useState<'admin' | 'user'>('user');
  const [formDesc, setFormDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Newly created key display modal
  const [createdKey, setCreatedKey] = useState<ApiKeyItem | null>(null);
  const [newKeyCopied, setNewKeyCopied] = useState(false);
  useBodyScrollLock(showCreateModal || !!createdKey);

  // Active tab for quick connect code examples (dual protocol: OpenAI + Anthropic)
  const [connectTab, setConnectTab] = useState<
    'cursor' | 'claude' | 'python' | 'anthropic' | 'curl' | 'anthropic-curl'
  >('cursor');

  const [page, setPage] = useState(1);
  const [keyPageSize, setKeyPageSize] = useState(KEY_PAGE_SIZE);
  const pagedKeys = keys.slice((page - 1) * keyPageSize, page * keyPageSize);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const res = await api.getApiKeys();
      if (res.status === 'ok') {
        setKeys(res.keys || []);
      }
    } catch (err: any) {
      console.error('Failed to load api keys:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleToggleShowSecret = (id: string) => {
    setShowSecret((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleToggleEnabled = async (item: ApiKeyItem) => {
    try {
      const nextState = !item.enabled;
      const res = await api.updateApiKey(item.id, { enabled: nextState });
      if (res.success) {
        setKeys((prev) => prev.map((k) => (k.id === item.id ? { ...k, enabled: nextState } : k)));
      } else {
        toast.error(res.error || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleDelete = async (item: ApiKeyItem) => {
    const confirmMsg = t('apiKeys.deleteConfirm').replace('{name}', item.name);
    const ok = await confirmDialog({ title: confirmMsg, danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;

    try {
      const res = await api.deleteApiKey(item.id);
      if (res.success) {
        setKeys((prev) => prev.filter((k) => k.id !== item.id));
      } else {
        toast.error(res.error || t('common.failed'));
      }
    } catch (err: any) {
      toast.error(err.message || t('common.failed'));
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setErrorMessage(t('apiKeys.namePlaceholder'));
      return;
    }

    try {
      setCreating(true);
      setErrorMessage('');
      const res = await api.createApiKey({
        name: formName.trim(),
        key: formKey.trim() || undefined,
        role: formRole,
        description: formDesc.trim() || undefined,
      });

      if (res.success && res.data) {
        setCreatedKey(res.data);
        setShowCreateModal(false);
        setFormName('');
        setFormKey('');
        setFormDesc('');
        setFormRole('user');
        fetchKeys();
      } else {
        setErrorMessage(res.error || t('common.saveFailed'));
      }
    } catch (err: any) {
      setErrorMessage(err.message || t('common.saveFailed'));
    } finally {
      setCreating(false);
    }
  };

  const activeCount = keys.filter((k) => k.enabled).length;
  const isAuthProtected = keys.length > 0;
  const sampleKey = keys[0]?.key || 'sk-ocr-your-client-api-key';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 1. Header Hero Card */}
      <div
        className="card"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              background: 'rgba(6, 182, 212, 0.12)',
              border: '1px solid rgba(6, 182, 212, 0.3)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <KeyRound size={22} />
          </div>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-main)' }}>
              {t('apiKeys.title')}
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {t('apiKeys.desc')}
            </p>
          </div>
        </div>

        <button
          onClick={() => {
            setErrorMessage('');
            setShowCreateModal(true);
          }}
          className="btn btn-primary"
          style={{ padding: '9px 18px', fontSize: '13px' }}
        >
          <Plus size={16} />
          <span>{t('apiKeys.newKeyBtn')}</span>
        </button>
      </div>

      {/* 2. Metrics Statistics Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
            {t('apiKeys.totalKeys')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '8px', color: 'var(--text-main)' }}>
            {keys.length}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
            {t('apiKeys.activeKeys')}
          </div>
          <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '8px', color: 'var(--accent-emerald)' }}>
            {activeCount}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-dim)' }}>
            {t('apiKeys.authStatus')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
            {isAuthProtected ? (
              <>
                <ShieldCheck size={20} color="var(--accent-emerald)" />
                <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-emerald)' }}>
                  {t('apiKeys.authProtected')}
                </span>
              </>
            ) : (
              <>
                <ShieldAlert size={20} color="var(--accent-amber)" />
                <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-amber)' }}>
                  {t('apiKeys.authOpen')}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 3. Keys Table Container */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
            {t('common.loading')}
          </div>
        ) : keys.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center' }}>
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                background: 'rgba(255, 255, 255, 0.05)',
                color: 'var(--text-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px auto',
              }}
            >
              <KeyRound size={24} />
            </div>
            <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-main)' }}>
              {t('apiKeys.emptyTitle')}
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '420px', margin: '4px auto 16px auto' }}>
              {t('apiKeys.emptyDesc')}
            </p>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary btn-sm">
              <Plus size={14} />
              <span>{t('apiKeys.newKeyBtn')}</span>
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr
                  style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderBottom: '1px solid var(--card-border)',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thName')}</th>
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thKey')}</th>
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thRole')}</th>
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thStatus')}</th>
                  <th style={{ padding: '12px 20px' }}>{t('apiKeys.thCreated')}</th>
                  <th style={{ padding: '12px 20px', textAlign: 'right' }}>{t('apiKeys.thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {pagedKeys.map((item) => {
                  const isVisible = showSecret[item.id];
                  const displayKey = isVisible
                    ? item.key
                    : item.key.slice(0, 8) + '••••••••' + item.key.slice(-4);

                  return (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: '1px solid var(--card-border)',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      {/* Name & Desc */}
                      <td style={{ padding: '14px 20px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-main)' }}>{item.name}</div>
                        {item.description && (
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>
                            {item.description}
                          </div>
                        )}
                      </td>

                      {/* Secret Key Display */}
                      <td style={{ padding: '14px 20px', fontFamily: 'JetBrains Mono, Consolas, monospace' }}>
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '8px',
                            background: 'var(--input-bg)',
                            border: '1px solid var(--card-border)',
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            color: 'var(--text-main)',
                          }}
                        >
                          <span>{displayKey}</span>
                          <button
                            onClick={() => handleToggleShowSecret(item.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-dim)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '2px',
                            }}
                            title="Toggle visibility"
                          >
                            {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button
                            onClick={() => handleCopy(item.key, item.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: copiedId === item.id ? 'var(--accent-emerald)' : 'var(--text-dim)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '2px',
                            }}
                            title="Copy Key"
                          >
                            {copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        </div>
                      </td>

                      {/* Role */}
                      <td style={{ padding: '14px 20px' }}>
                        <span
                          className="badge"
                          style={{
                            background: item.role === 'admin' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                            color: item.role === 'admin' ? 'var(--accent-violet)' : 'var(--text-muted)',
                            border: item.role === 'admin' ? '1px solid rgba(139, 92, 246, 0.3)' : '1px solid var(--card-border)',
                          }}
                        >
                          {item.role || 'user'}
                        </span>
                      </td>

                      {/* Status switch */}
                      <td style={{ padding: '14px 20px' }}>
                        <button
                          onClick={() => handleToggleEnabled(item)}
                          className={item.enabled ? 'badge badge-success' : 'badge'}
                          style={{
                            cursor: 'pointer',
                            border: '1px solid',
                            borderColor: item.enabled ? 'rgba(16, 185, 129, 0.3)' : 'var(--card-border)',
                            background: item.enabled ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                            color: item.enabled ? 'var(--accent-emerald)' : 'var(--text-dim)',
                          }}
                          title={item.enabled ? t('apiKeys.enableTooltip') : t('apiKeys.disableTooltip')}
                        >
                          <span
                            className={item.enabled ? 'dot-pulse' : ''}
                            style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              background: item.enabled ? 'var(--accent-emerald)' : 'var(--text-dim)',
                              display: 'inline-block',
                            }}
                          />
                          <span>{item.enabled ? t('apiKeys.statusActive') : t('apiKeys.statusDisabled')}</span>
                        </button>
                      </td>

                      {/* Created At */}
                      <td style={{ padding: '14px 20px', fontSize: '11px', color: 'var(--text-dim)' }}>
                        {new Date(item.createdAt).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                        <button
                          onClick={() => handleDelete(item)}
                          className="btn btn-danger btn-sm"
                          style={{ padding: '4px 8px' }}
                          title={t('apiKeys.deleteTooltip')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {keys.length > 0 && (
          <div style={{ padding: '0 20px 16px' }}>
            <Pagination
              page={page}
              pageSize={keyPageSize}
              total={keys.length}
              onChange={setPage}
              showSummary
              pageSizeOptions={KEY_PAGE_SIZES}
              onPageSizeChange={(s) => { setKeyPageSize(s); setPage(1); }}
            />
          </div>
        )}
      </div>

      {/* 4. Quick Connect Integration Card */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={18} color="var(--accent)" />
            <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-main)' }}>
              {t('apiKeys.quickConnectTitle')}
            </h2>
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(
              [
                ['cursor', 'Cursor / IDE'],
                ['python', 'Python · OpenAI'],
                ['curl', 'cURL · OpenAI'],
                ['claude', 'Claude Code'],
                ['anthropic', 'Python · Anthropic'],
                ['anthropic-curl', 'cURL · Anthropic'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setConnectTab(tab)}
                className={`btn btn-sm ${connectTab === tab ? 'btn-primary' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {t('apiKeys.quickConnectDesc')}
        </p>

        <pre
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: '8px',
            padding: '16px',
            fontFamily: 'JetBrains Mono, Consolas, monospace',
            fontSize: '12px',
            color: 'var(--text-main)',
            overflowX: 'auto',
            lineHeight: 1.6,
          }}
        >
          {connectTab === 'cursor' && (
`# 1. 打开 Cursor -> Settings -> Models -> OpenAI API Key
# 2. 勾选 "Override OpenAI Base URL"，填入：
http://127.0.0.1:3000/v1

# 3. 在 API Key 中填入上方配发的客户端 API Key：
${sampleKey}

# 4. 模型名称选择或添加：
#    虚拟分流模型：auto / auto-fast / auto-flagship / auto-reasoning
#    或具体模型（完整 ID）：opencode/claude-sonnet-5-5、opencode/gpt-6-sol、opencode/glm-5.3`
          )}

          {connectTab === 'python' && (
`from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="${sampleKey}"
)

response = client.chat.completions.create(
    model="auto", # 智能分流：auto / auto-fast / auto-flagship / auto-reasoning
    messages=[{"role": "user", "content": "Hello OCR Gateway!"}]
)

print(response.choices[0].message.content)`
          )}

          {connectTab === 'curl' && (
`curl http://127.0.0.1:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${sampleKey}" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Ping!"}]
  }'`
          )}

          {connectTab === 'claude' && (
`# 1. 设置环境变量（或写入 ~/.claude/settings.json 的 "env" 字段）：
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=${sampleKey}

# 2. 可选：默认模型（auto = 智能分流，也可 auto-fast / auto-flagship / auto-reasoning）
export ANTHROPIC_MODEL=auto

# 3. 正常启动 claude 即可。Claude Code 的请求将自动走网关的
#    Anthropic 协议端点：POST {ANTHROPIC_BASE_URL}/v1/messages
#    （鉴权兼容 x-api-key 与 Authorization: Bearer 两种头）`
          )}

          {connectTab === 'anthropic' && (
`from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:3000",  # SDK 自动拼接 /v1/messages
    api_key="${sampleKey}"
)

message = client.messages.create(
    model="auto", # 智能分流：auto / auto-fast / auto-flagship / auto-reasoning
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello OCR Gateway!"}]
)

print(message.content[0].text)`
          )}

          {connectTab === 'anthropic-curl' && (
`curl http://127.0.0.1:3000/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${sampleKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "auto",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Ping!"}]
  }'`
          )}
        </pre>
      </div>

      {/* 5. Modal: Create API Key */}
      {showCreateModal && (
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
              maxWidth: '460px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.createModalTitle')}
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {errorMessage && (
              <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'rgba(244, 63, 94, 0.15)', border: '1px solid rgba(244, 63, 94, 0.3)', color: 'var(--accent-rose)', fontSize: '12px' }}>
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleCreateSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.nameLabel')} <span style={{ color: 'var(--accent-rose)' }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('apiKeys.namePlaceholder')}
                  className="input"
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.customKeyLabel')}
                </label>
                <input
                  type="text"
                  value={formKey}
                  onChange={(e) => setFormKey(e.target.value)}
                  placeholder={t('apiKeys.customKeyPlaceholder')}
                  className="input"
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.roleLabel')}
                </label>
                <Combobox
                  style={{ cursor: 'pointer' }}
                  value={formRole}
                  onChange={(v) => setFormRole(v as 'admin' | 'user')}
                  options={[
                    { value: 'user', label: t('apiKeys.roleUser') },
                    { value: 'admin', label: t('apiKeys.roleAdmin') },
                  ]}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)', display: 'block', marginBottom: '6px' }}>
                  {t('apiKeys.descLabel')}
                </label>
                <textarea
                  rows={2}
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder={t('apiKeys.descPlaceholder')}
                  className="input"
                  style={{ resize: 'none' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button type="button" onClick={() => setShowCreateModal(false)} className="btn">
                  {t('apiKeys.cancelBtn')}
                </button>
                <button type="submit" disabled={creating} className="btn btn-primary">
                  {creating ? t('common.loading') : t('apiKeys.createBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 6. Modal: Key Created Success Alert */}
      {createdKey && (
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
              maxWidth: '460px',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: 'rgba(16, 185, 129, 0.15)',
                  color: 'var(--accent-emerald)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Check size={18} />
              </div>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)' }}>
                {t('apiKeys.createdNoticeTitle')}
              </h3>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {t('apiKeys.createdNoticeDesc')}
            </p>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                background: 'var(--input-bg)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                padding: '10px 14px',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono, Consolas, monospace',
                fontSize: '12px',
                color: 'var(--accent-emerald)',
                wordBreak: 'break-all',
              }}
            >
              <span>{createdKey.key}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdKey.key);
                  setNewKeyCopied(true);
                  setTimeout(() => setNewKeyCopied(false), 2000);
                }}
                className="btn btn-sm"
                title="Copy Key"
              >
                {newKeyCopied ? <Check size={14} color="var(--accent-emerald)" /> : <Copy size={14} />}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
              <button onClick={() => setCreatedKey(null)} className="btn btn-primary">
                {t('apiKeys.doneBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
