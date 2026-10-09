import { loadConfig } from './config/index.js';
import { createServer } from './server.js';
import { ProviderRegistry } from './providers/registry.js';
import { DispatchingProvider } from './providers/dispatch.js';
import { buildDirectPool } from './providers/boot-direct.js';
import { FinOpsTracker } from './metrics/finops-tracker.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';

import { Layer1Classifier } from './router/layer1-classifier.js';
import { catalogRepository } from './opencode/catalog/repository.js';
import { initProxyConfig } from './utils/proxy.js';
import { adoptRestartParent, writeDaemonFiles } from './cli/daemon.js';

async function main() {
  // If this process was spawned by the UI "Restart Gateway" button, wait for
  // the old gateway to die (and take over) before booting further.
  const isRestartChild = await adoptRestartParent();

  const config = loadConfig();
  initProxyConfig(config.proxy);

  // -1. Provider/model catalog sync (config-driven sources; defaults when unset)
  try {
    catalogRepository.applyConfig(config.catalog);
    await catalogRepository.start();
    console.log(`[OCR] Catalog synced: ${catalogRepository.lastSyncOrigin}`);
  } catch (err: any) {
    console.warn(`[OCR] Catalog sync failed (will retry on interval): ${err.message}`);
  }

  // 0. Auto-initialize Layer 1 model base scaffold
  await Layer1Classifier.init(config.classifier?.localModel);
  console.log(`[OCR] Layer 1 classifier ready: ${Layer1Classifier.getModelStatus()}`);

  // 1. ADR-0011: pure direct execution. The opencode daemon is NOT in the
  //    request path; truth sources are opencode.jsonc + auth.json + models.dev
  //    catalog (all files, resolved at boot). Wire per model comes from the
  //    shared wireFor() the console probe uses — test ≡ inference by structure.
  const tracker = new FinOpsTracker();

  let registry: ProviderRegistry;
  try {
    const boot = await buildDirectPool();
    config.models = boot.models;
    const defaultFlagship = boot.models.find((m) => m.tier === 'flagship' && m.isDefaultInTier) || boot.models[0];
    config.baselineModel = defaultFlagship?.id || 'auto';

    registry = new ProviderRegistry(config, boot.models.length === 0);
    for (const inst of boot.instances) {
      registry.registerProvider(inst.name, new DispatchingProvider(inst.config, inst.wireBases));
    }
    console.log(
      `[OCR] Direct pool: ${boot.instances.length} providers / ${boot.models.length} models (ADR-0011, no daemon)`
    );
    const providerLevel = boot.excluded.filter((e) => !e.model);
    const modelLevel = boot.excluded.filter((e) => e.model);
    for (const ex of providerLevel) console.log(`[OCR]   excluded ${ex.provider}: ${ex.reason}`);
    if (modelLevel.length > 0)
      console.log(`[OCR]   ${modelLevel.length} models excluded (non-text wire/modality), e.g. ${modelLevel.slice(0, 3).map((e) => e.model).join(', ')}`);
  } catch (err: any) {
    console.warn(`[OCR] Direct pool build failed, falling back to standalone config: ${err.message}`);
    registry = new ProviderRegistry(config, true);
  }

  const orchestrator = new PipelineOrchestrator(config, registry, tracker);
  const { app } = createServer(config, false, registry, orchestrator);

  try {
    await app.listen({ port: config.port, host: config.host });
    // A UI-restart child must self-register: the pid/info files still point at
    // the old (now-exiting) gateway, and nobody else rewrites them.
    if (isRestartChild) writeDaemonFiles(process.pid, config.port, config.host);
    console.log('\n============================================================');
    console.log(`🚀 OCR Gateway (OpenCode Router) is ready! (OpenAI API Compatible)`);
    console.log(`👉 API Base URL     : http://127.0.0.1:${config.port}/v1`);
    console.log(`👉 Default Model    : auto (Virtual models: auto, auto-fast, auto-flagship, auto-reasoning)`);
    console.log(`👉 Chat Completions : http://127.0.0.1:${config.port}/v1/chat/completions`);
    console.log(`👉 Anthropic Msgs   : http://127.0.0.1:${config.port}/v1/messages`);
    console.log(`👉 Models List      : http://127.0.0.1:${config.port}/v1/models`);
    console.log(`👉 FinOps Metrics   : http://127.0.0.1:${config.port}/v1/metrics`);
    console.log(`👉 Sessions Inspect : http://127.0.0.1:${config.port}/v1/sessions`);
    console.log('============================================================\n');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
