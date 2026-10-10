import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { SPA_ROUTES } from '../src/routes/console.js';

/**
 * Regression guard: every SPA_ROUTES entry must serve the console HTML on a
 * DIRECT request (browser refresh / deep link). A console page missing from
 * SPA_ROUTES 401s (auth hook) or 404s on refresh even though client-side
 * routing works — exactly the /proxy-access incident. This test fails loudly
 * when a new page is added without its route being served.
 */
describe('SPA route serving (refresh-safe deep links)', () => {
  it('every SPA_ROUTES entry returns 200 text/html', async () => {
    const { app } = createServer(loadConfig(), true);
    for (const route of SPA_ROUTES) {
      const res = await app.inject({ method: 'GET', url: route });
      assert.equal(res.statusCode, 200, `${route} returned ${res.statusCode}`);
      assert.ok(
        String(res.headers['content-type']).includes('text/html'),
        `${route} content-type: ${res.headers['content-type']}`
      );
    }
  });
});