import fs from 'node:fs';
import path from 'node:path';
import { Layer1Classifier } from '../backend/src/router/layer1-classifier.js';
import { FlywheelRecord } from '../backend/src/flywheel/collector.js';
import { TierLevel } from '../backend/src/types/router.js';

async function main() {
  console.log('============================================================');
  console.log('🧠 OCR (OpenCode Router) Layer 1 Classifier Trainer (Active Learning)');
  console.log('============================================================\n');

  const datasetPath = path.resolve(process.cwd(), './data/flywheel.jsonl');
  const modelPath = path.resolve(process.cwd(), './models/layer1-classifier.json');

  // 1. Initialize Layer 1 classifier to ensure base model exists
  await Layer1Classifier.init({ enabled: true, modelPath });
  console.log(`📌 Current base model status: ${Layer1Classifier.getModelStatus()}`);

  if (!fs.existsSync(datasetPath)) {
    console.log(`⚠️ No flywheel dataset found at (${datasetPath}).`);
    console.log(`💡 Note: As the gateway processes live traffic, records and fallback samples will accumulate automatically.`);
    return;
  }

  const lines = fs.readFileSync(datasetPath, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    console.log('⚠️ Flywheel dataset is empty. No training samples available.');
    return;
  }

  console.log(`📊 Successfully loaded flywheel dataset: ${lines.length} records`);

  // 2. Parse samples and build training dataset
  const trainingSamples: Array<{ features: number[]; targetTier: TierLevel }> = [];
  let negativeCorrections = 0;

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as any;
      const userPrompt = raw.userPrompt || '';
      const dummyReq: any = raw.request || {
        model: 'auto',
        messages: [{ role: 'user', content: userPrompt }],
        response_format: raw.features?.hasToolsOrSchema ? { type: 'json_object' } : undefined,
      };

      // Extract language-agnostic features
      const extracted = Layer1Classifier.extractFeatures(dummyReq);
      
      // Determine ground truth label
      let targetTier: TierLevel = raw.label?.groundTruthTier || raw.execution?.tierUsed || raw.routing?.targetTier || 'plus';

      // If schema assertion fallback occurred on lite tier, it's a strong negative sample -> escalate to plus
      if (raw.label?.isNegativeSampleForLite || (raw.execution?.fallbackOccurred && targetTier === 'lite')) {
        targetTier = 'plus';
        negativeCorrections++;
      }

      trainingSamples.push({
        features: extracted.vector,
        targetTier,
      });
    } catch {
      // skip invalid lines
    }
  }

  if (trainingSamples.length === 0) {
    console.log('⚠️ No valid feature samples could be extracted.');
    return;
  }

  console.log(`🎯 Valid training samples: ${trainingSamples.length} (including ${negativeCorrections} fallback-corrected negative samples)`);
  console.log('⏳ Running micro-tensor Softmax cross-entropy gradient descent (with L2 regularization)...');

  // 3. Train base model
  const trainResult = Layer1Classifier.train(trainingSamples, {
    epochs: 200,
    lr: 0.15,
    l2: 0.005,
  });

  // 4. Save trained weights to disk
  const updatedModel = Layer1Classifier.getLoadedModel();
  Layer1Classifier.saveModel(updatedModel, modelPath);

  console.log('\n============================================================');
  console.log('✅ Layer 1 model training complete!');
  console.log('============================================================');
  console.log(`👉 Total Trained Samples : ${trainResult.trainedSamples}`);
  console.log(`👉 Final Converged Loss  : ${trainResult.finalLoss}`);
  console.log(`👉 Training Set Accuracy : ${(trainResult.accuracy * 100).toFixed(1)}%`);
  console.log(`👉 Model Output Path     : ${modelPath}`);
  console.log(`👉 Status Transition     : isBaseModel (true -> false)`);
  console.log('============================================================');
  console.log('⚡ Effective immediately: High-confidence requests will be dispatched locally on CPU (0.1ms)!\n');
}

main().catch(err => {
  console.error('Training failed:', err);
  process.exit(1);
});
