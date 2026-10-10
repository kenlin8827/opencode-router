import fs from 'node:fs';
import path from 'node:path';

function main() {
  const filePath = path.resolve(process.cwd(), './data/flywheel.jsonl');
  if (!fs.existsSync(filePath)) {
    console.log(`[Flywheel] No dataset found at ${filePath}. Make some requests first!`);
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  console.log(`\n======================================================`);
  console.log(`📊 OCR (OpenCode Router) - Active Learning Data Flywheel Analytics`);
  console.log(`======================================================`);
  console.log(`📂 Dataset Path: ${filePath}`);
  console.log(`📝 Total Accumulated Samples: ${lines.length}`);

  let tierCounts: Record<string, number> = { lite: 0, plus: 0, pro: 0, ultra: 0 };
  let layerCounts: Record<string, number> = { layer0: 0, layer1: 0, layer2: 0 };
  let fallbackCount = 0;
  let totalCostUsd = 0;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const tier = record.label?.groundTruthTier || 'lite';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;

      const layer = record.routing?.layerUsed || 'layer0';
      layerCounts[layer] = (layerCounts[layer] || 0) + 1;

      if (record.execution?.fallbackOccurred) {
        fallbackCount++;
      }
      totalCostUsd += record.execution?.costUsd || 0;
    } catch {
      // skip invalid line
    }
  }

  console.log(`\n--- Ground Truth Labels Distribution ---`);
  for (const [tier, count] of Object.entries(tierCounts)) {
    const pct = ((count / lines.length) * 100).toFixed(1);
    console.log(`  • ${tier}: ${count} (${pct}%)`);
  }

  console.log(`\n--- Decision Layer Distribution ---`);
  for (const [layer, count] of Object.entries(layerCounts)) {
    const pct = ((count / lines.length) * 100).toFixed(1);
    console.log(`  • ${layer}: ${count} (${pct}%)`);
  }

  console.log(`\n--- Cascading Fallback & Negative Samples ---`);
  console.log(`  • Fallback Escalations (lite failed -> plus): ${fallbackCount} (${((fallbackCount / lines.length) * 100).toFixed(1)}%)`);
  console.log(`  • Total Sample Execution Cost: $${totalCostUsd.toFixed(6)}`);
  console.log(`======================================================\n`);
}

main();
