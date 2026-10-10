import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Layer1Classifier, DEFAULT_BASE_MODEL } from '../src/router/layer1-classifier.js';
import { Layer2Judge } from '../src/router/layer2-judge.js';
import { RouterEngine } from '../src/router/index.js';
import { FlywheelCollector } from '../src/flywheel/collector.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('Layer 1 & Layer 2 Routing and Data Flywheel', () => {
  const testFlywheelPath = path.resolve(process.cwd(), './data/test_flywheel.jsonl');
  const testModelPath = path.resolve(process.cwd(), './models/test_layer1_classifier.json');

  beforeEach(() => {
    if (fs.existsSync(testFlywheelPath)) {
      fs.unlinkSync(testFlywheelPath);
    }
    if (fs.existsSync(testModelPath)) {
      fs.unlinkSync(testModelPath);
    }
  });

  afterEach(() => {
    Layer1Classifier.resetToBaseModel();
    if (fs.existsSync(testFlywheelPath)) {
      fs.unlinkSync(testFlywheelPath);
    }
    if (fs.existsSync(testModelPath)) {
      fs.unlinkSync(testModelPath);
    }
  });

  it('Layer 1 should auto-initialize empty base model scaffold with guaranteed low confidence (< 0.85)', async () => {
    // Initialize with a test path that does not exist yet
    await Layer1Classifier.init({ enabled: true, modelPath: testModelPath });

    // 1. Verify file was physically created on disk
    assert.ok(fs.existsSync(testModelPath), 'Base model file should be auto-created on disk');
    assert.strictEqual(Layer1Classifier.isBaseModel(), true, 'Should be flagged as base model');

    // 2. Perform forward pass on general prompt (not structured protocol)
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain quantum computing' }],
    };

    const pred = Layer1Classifier.predict(req, { enabled: true, confidenceThreshold: 0.85 });

    // Mathematical guarantees of untrained base model:
    assert.strictEqual(pred.isConfident, false, 'Untrained base model confidence must be insufficient');
    assert.ok(pred.confidence < 0.40, `Confidence ${pred.confidence} should be near uniform 0.33`);
    assert.strictEqual(pred.isBaseModel, true);
    assert.ok(pred.reason.includes('scaffold'), 'Reason should identify base model scaffold');
  });

  it('RouterEngine.routeAsync should cascade untrained base model to Layer 2, never short-circuiting', async () => {
    // Reset to base model
    await Layer1Classifier.init({ enabled: true, modelPath: testModelPath });

    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    };

    const decision = await RouterEngine.routeAsync(req, undefined, {
      localModel: { enabled: true, confidenceThreshold: 0.85 },
      // Layer 2 not enabled in this unit test -> cascades to default safe plus baseline
    });

    // Layer 1 didn't claim high confidence -> gracefully passed to default/Layer 2
    assert.strictEqual(decision.targetTier, 'plus');
    assert.strictEqual(decision.layerUsed, 'layer1');
    assert.ok(decision.confidence < 0.50);
  });

  it('Layer 1 Layer1Classifier can be trained in-place from samples to produce confident predictions', async () => {
    await Layer1Classifier.init({ enabled: true, modelPath: testModelPath });

    // Generate training samples for Fast vs Reasoning
    const reqFast: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const reqReasoning: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'Complex logic thinking system' },
        { role: 'user', content: '```python\ndef solve_np_hard(): pass\n```\n' + 'x = y + z; '.repeat(50) },
      ],
    };

    const featFast = Layer1Classifier.extractFeatures(reqFast).vector;
    const featReasoning = Layer1Classifier.extractFeatures(reqReasoning).vector;

    const samples = [
      ...Array(20).fill({ features: featFast, targetTier: 'lite' as const }),
      ...Array(20).fill({ features: featReasoning, targetTier: 'pro' as const }),
    ];

    const trainRes = Layer1Classifier.train(samples, { epochs: 100, lr: 0.2 });
    assert.strictEqual(trainRes.trainedSamples, 40);
    assert.ok(trainRes.accuracy > 0.80, `Trained accuracy should be high: ${trainRes.accuracy}`);
    assert.strictEqual(Layer1Classifier.isBaseModel(), false, 'Model is now trained, no longer empty base');

    // Predict on reqReasoning with low threshold
    const predAfterTrain = Layer1Classifier.predict(reqReasoning, { enabled: true, confidenceThreshold: 0.50 });
    assert.strictEqual(predAfterTrain.isConfident, true);
    assert.strictEqual(predAfterTrain.targetTier, 'pro');
  });

  it('Layer 1 Layer1Classifier should produce calibrated probabilities and respect confidence gating for schema tasks', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Generate JSON data' }],
      response_format: { type: 'json_object' },
    };

    // 1. High confidence threshold (e.g. 0.99) -> isConfident = false
    const predStrict = Layer1Classifier.predict(req, { enabled: true, confidenceThreshold: 0.99 });
    assert.strictEqual(predStrict.isConfident, false);
    assert.strictEqual(predStrict.targetTier, 'lite');
    assert.ok(predStrict.probabilities.lite > 0.5);

    // 2. Realistic threshold (0.70) -> isConfident = true
    const predNormal = Layer1Classifier.predict(req, { enabled: true, confidenceThreshold: 0.70 });
    assert.strictEqual(predNormal.isConfident, true);
    assert.strictEqual(predNormal.targetTier, 'lite');
  });

  it('FlywheelCollector should log samples and record negative sample flag on schema fallback', async () => {
    const collector = new FlywheelCollector({
      enabled: true,
      datasetPath: testFlywheelPath,
      logUserPrompt: true,
    });

    const dummyReq: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract invoice json data' }],
    };

    // Record sample 1: successful Lite tier run
    await collector.record({
      requestId: 'test-req-1',
      request: dummyReq,
      decision: {
        targetTier: 'lite',
        confidence: 0.9,
        layerUsed: 'layer0',
        reason: 'Fast rule',
        needsSchemaValidation: true,
        features: {
          tokenCountEstimate: 20,
          hasCode: false,
          hasMathOrProof: false,
          hasMultiTurn: false,
          hasToolsOrSchema: true,
          complexityScore: 2.0,
        },
      },
      tierUsed: 'lite',
      modelUsed: 'mock-lite',
      fallbackOccurred: false,
      costUsd: 0.0001,
      latencyMs: 120,
    });

    // Record sample 2: Lite tier schema assertion failed -> Escalated fallback to plus
    await collector.record({
      requestId: 'test-req-2',
      request: dummyReq,
      decision: {
        targetTier: 'lite',
        confidence: 0.85,
        layerUsed: 'layer0',
        reason: 'Initial guess',
        needsSchemaValidation: true,
        features: {
          tokenCountEstimate: 50,
          hasCode: false,
          hasMathOrProof: false,
          hasMultiTurn: false,
          hasToolsOrSchema: true,
          complexityScore: 3.5,
        },
      },
      tierUsed: 'plus',
      modelUsed: 'mock-plus',
      fallbackOccurred: true,
      fallbackReason: 'Missing field: invoiceNumber',
      costUsd: 0.002,
      latencyMs: 850,
    });

    const stats = collector.getStats();
    assert.strictEqual(stats.totalSamples, 2);
    assert.strictEqual(stats.fallbackCount, 1);
    assert.strictEqual(stats.negativeSampleCount, 1);
    assert.strictEqual(stats.tierDistribution.lite, 1);
    assert.strictEqual(stats.tierDistribution.plus, 1);

    // Verify written file content
    assert.ok(fs.existsSync(testFlywheelPath));
    const content = fs.readFileSync(testFlywheelPath, 'utf8').trim().split('\n');
    assert.strictEqual(content.length, 2);

    const record2 = JSON.parse(content[1]);
    assert.strictEqual(record2.id, 'test-req-2');
    assert.strictEqual(record2.label.isNegativeSampleForLite, true);
    assert.strictEqual(record2.label.groundTruthTier, 'plus');
    assert.strictEqual(record2.label.labelSource, 'runtime_fallback');
  });
});
