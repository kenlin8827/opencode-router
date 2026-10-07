import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { ChainsPage } from './pages/ChainsPage';
import { RulesPage } from './pages/RulesPage';
import { KeysPage } from './pages/KeysPage';
import { ModelsPage } from './pages/ModelsPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { GuardrailsPage } from './pages/GuardrailsPage';
import { UsagePage } from './pages/UsagePage';
import { ClientsPage } from './pages/ClientsPage';
import { SettingsPage } from './pages/SettingsPage';
import { YamlPage } from './pages/YamlPage';
import { ConfirmProvider } from './components/ConfirmProvider';
import { ToastProvider } from './components/ToastProvider';

export const App: React.FC = () => {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="chains" element={<ChainsPage />} />
        <Route path="tiers" element={<RulesPage />} />
        <Route path="rules" element={<Navigate to="/tiers" replace />} />
        <Route path="cache" element={<ChainsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="providers" element={<KeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="guardrails" element={<GuardrailsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="yaml" element={<YamlPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
        </Routes>
      </ConfirmProvider>
    </ToastProvider>
  );
};
