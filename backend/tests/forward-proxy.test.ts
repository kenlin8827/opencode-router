import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseClientHelloSNI } from '../src/forward-proxy/sni.js';
import { isLoopbackHost, matchBypass } from '../src/forward-proxy/bypass.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { createProxyInterceptor } from '../src/forward-proxy/interceptor.js';

/**
 * Forward-proxy suite. NOTE: run per-file (`bun test tests/forward-proxy.test.ts`)
 * — the full-suite node:test describe-nesting cascade on this machine is noisy.
 * These tests exercise the REAL sockets/TLS handshakes (the Bun-specific MITM
 * plumbing cannot be faithfully mocked).
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-'));
}

/** Send CONNECT through the proxy; resolve once the 200 is received. */
function connectViaProxy(proxyPort: number, targetHost: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:${port} HTTP/1.1\r\nHost: ${targetHost}:${port}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        resolve(sock);
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

/** TLS handshake over an established CONNECT socket (validates against ca). */
function tlsOver(socket: net.Socket, servername: string, ca: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, ca, rejectUnauthorized: true }, () => resolve(t));
    t.on('error', reject);
  });
}

/** One HTTP/1.1 request over a TLS socket; resolves the full raw response. */
function httpRequest(tlsSock: tls.TLSSocket, host: string, method: string, p: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers = [`${method} ${p} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
    if (body !== undefined) {
      headers.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
    }
    tlsSock.write(headers.join('\r\n') + '\r\n\r\n' + (body ?? ''));
    let buf = '';
    tlsSock.on('data', (d: Buffer) => (buf += d.toString()));
    tlsSock.on('end', () => resolve(buf));
    tlsSock.on('close', () => resolve(buf));
    tlsSock.on('error', reject);
  });
}

describe('forward-proxy: SNI probing + bypass policy', () => {
  it('parseClientHelloSNI extracts the servername from a real ClientHello', async () => {
    const captured = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      const srv = net.createServer((sock) => {
        sock.once('data', (d: Buffer) => {
          clearTimeout(timer);
          resolve(d);
          sock.destroy();
          srv.close();
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        const c = tls.connect({ host: '127.0.0.1', port, servername: 'sni.example.com', rejectUnauthorized: false });
        c.on('error', () => {}); // handshake never completes
      });
    });
    assert.equal(parseClientHelloSNI(captured), 'sni.example.com');
    assert.equal(parseClientHelloSNI(Buffer.from('not-tls')), null);
  });

  it('bypass matcher: loopback always bypasses; globs match hosts', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('api.openai.com'), false);

    assert.equal(matchBypass('api.openai.com', []).bypassed, false);
    assert.equal(matchBypass('api.openai.com', undefined).bypassed, false);
    assert.equal(matchBypass('api.openai.com', ['*.internal']).bypassed, false);
    assert.equal(matchBypass('db.internal', ['*.internal']).bypassed, true);
    assert.equal(matchBypass('1.2.3.4', []).bypassed, false);
    assert.equal(matchBypass('127.0.0.1', ['nothing-matches']).bypassed, true);

    // matchBypass: per-host egress flag (object entries); loopback stays direct
    assert.deepEqual(matchBypass('api.openai.com', []), { bypassed: false, viaProxy: false });
    assert.deepEqual(matchBypass('api.openai.com', ['*.openai.com']), { bypassed: true, viaProxy: false });
    assert.deepEqual(matchBypass('api.openai.com', [{ host: 'api.openai.com', viaProxy: true }]), { bypassed: true, viaProxy: true });
    assert.deepEqual(matchBypass('127.0.0.1', [{ host: '127.*', viaProxy: true }]), { bypassed: true, viaProxy: false });
  });
});

describe('forward-proxy: CA + certificate minting', () => {
  it('generates a persistent CA and leaf certs that verify + hostname-match', () => {
    const dir = tmpCaDir();
    const ca = ensureCa(dir);
    assert.ok(fs.existsSync(path.join(dir, 'ca.pem')));
    assert.ok(fs.existsSync(path.join(dir, 'ca-key.pem')));

    const minter = new CertMinter(ca);
    const minted = minter.get('api.example.com');
    const x509 = new crypto.X509Certificate(minted.cert);
    const caX509 = new crypto.X509Certificate(ca.caCertPem);
    assert.equal(x509.verify(caX509.publicKey), true, 'leaf must verify against the CA');
    assert.equal(x509.checkHost('api.example.com'), 'api.example.com');
    assert.notEqual(x509.checkHost('other.example.com'), 'other.example.com');

    // Cache: same cert returned for the same host
    assert.equal(minter.get('api.example.com').cert, minted.cert);

    // Reload from disk — same CA material
    const ca2 = ensureCa(dir);
    assert.equal(ca2.caCertPem, ca.caCertPem);
  });
});

describe('forward-proxy: full MITM chain', () => {
  it('CONNECT → MITM → inner http → intercept handler sees the request', async () => {
    const dir = tmpCaDir();
    let seen: { method?: string; url?: string; host?: string } = {};
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: dir,
      intercept: async (req, res) => {
        seen = { method: req.method, url: req.url, host: req.headers.host };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    });

    const sock = await connectViaProxy(handle.port, 'mitm.test', 443);
    const tlsSock = await tlsOver(sock, 'mitm.test', handle.caCertPem);
    const resp = await httpRequest(tlsSock, 'mitm.test', 'POST', '/v1/chat/completions', '{"x":1}');

    assert.ok(resp.includes('200 OK'), `response: ${resp}`);
    assert.ok(resp.includes('{"ok":true}'), `response: ${resp}`);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.host, 'mitm.test');

    tlsSock.destroy();
    await handle.close();
  });

  it('loopback targets are blind-tunneled — the interceptor never runs', async () => {
    const echo = net.createServer((s) => {
      s.on('data', (d) => s.write(d));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;

    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async () => {
        intercepted += 1;
        return false;
      },
    });

    const sock = await connectViaProxy(handle.port, '127.0.0.1', echoPort);
    const echoed = await new Promise<string>((resolve) => {
      sock.once('data', (d: Buffer) => resolve(d.toString()));
      sock.write('ping');
    });
    assert.equal(echoed, 'ping');
    assert.equal(intercepted, 0);

    sock.destroy();
    echo.close();
    await handle.close();
  });
});

describe('forward-proxy: LLM protocol interceptor', () => {
  it('chat wire hit → orchestrator → JSON response + X-OCR headers', async () => {
    const calls: any[] = [];
    const stub = {
      process: async (request: any, ctx: any) => {
        calls.push({ request, ctx });
        return {
          response: {
            id: 'mock-cmpl',
            object: 'chat.completion',
            created: 1,
            model: 'mock-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          tierUsed: 'lite',
          modelUsed: 'mock-1',
          fallbackOccurred: false,
          costUsd: 0.0005,
          sessionId: 'sess-1',
          traceId: 'trace-1',
          latencyMs: 5,
          baselineCostUsd: 0,
          savedCostUsd: 0,
        };
      },
    } as any;

    const intercept = createProxyInterceptor(stub);
    const srv = http.createServer((req, res) => {
      void intercept(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('passthrough');
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;

    // 1) LLM request → intercepted
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.choices[0].message.content, 'hi');
    assert.equal(res.headers.get('x-ocr-model'), 'mock-1');
    assert.equal(res.headers.get('x-ocr-tier'), 'lite');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.wire, 'chat');

    // 2) non-LLM path → not intercepted (transparent forward territory)
    const res2 = await fetch(`http://127.0.0.1:${port}/some/other/api`, { method: 'POST', body: 'x' });
    assert.equal(res2.status, 404);
    assert.equal(await res2.text(), 'passthrough');
    assert.equal(calls.length, 1);

    // 3) streaming chat → SSE with [DONE]
    const res3 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res3.text();
    assert.ok(text.includes('data: '), text);
    assert.ok(text.includes('[DONE]'), text);

    // 4) anthropic wire → converted to anthropic message shape
    const res4 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res4.status, 200);
    const body4: any = await res4.json();
    assert.equal(body4.type, 'message');
    assert.equal(body4.content[0].text, 'hi');

    srv.close();
  });
});

describe('forward-proxy: over-the-wire routing (interceptor + MITM combined)', () => {
  it('a proxied client POST /v1/chat/completions is routed through the orchestrator', async () => {
    const stub = {
      process: async () => ({
        response: {
          id: 'mock-cmpl-2',
          object: 'chat.completion',
          created: 1,
          model: 'mock-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        tierUsed: 'plus',
        modelUsed: 'mock-2',
        fallbackOccurred: false,
        costUsd: 0.002,
        sessionId: 'sess-2',
        traceId: 'trace-2',
        latencyMs: 9,
        baselineCostUsd: 0,
        savedCostUsd: 0,
      }),
    } as any;

    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: createProxyInterceptor(stub),
    });

    const sock = await connectViaProxy(handle.port, 'llm.example.com', 443);
    const tlsSock = await tlsOver(sock, 'llm.example.com', handle.caCertPem);
    const resp = await httpRequest(
      tlsSock,
      'llm.example.com',
      'POST',
      '/v1/chat/completions',
      JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    );

    assert.ok(resp.includes('200 OK'), resp);
    assert.ok(resp.toLowerCase().includes('x-ocr-model: mock-2'), resp);
    assert.ok(resp.toLowerCase().includes('x-ocr-tier: plus'), resp);
    assert.ok(resp.includes('"content":"hi"'), resp);

    tlsSock.destroy();
    await handle.close();
  });
});

describe('forward-proxy: outbound-proxy transit (per-host viaProxy)', () => {
  it('object entries with viaProxy tunnel through the proxy; bare strings stay direct', async () => {
    // Fake echo target (stands in for the real blocked host)
    const echo = net.createServer((s) => {
      s.on('data', (d) => s.write(d));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as net.AddressInfo).port;

    // Fake CONNECT proxy: records the CONNECT line, tunnels to the echo server
    const proxyConnects: string[] = [];
    const fakeProxy = net.createServer((client) => {
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        client.removeListener('data', onData);
        proxyConnects.push(buf.split('\r\n')[0]);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const up = net.connect(echoPort, '127.0.0.1');
        up.on('connect', () => {
          const rest = buf.slice(buf.indexOf('\r\n\r\n') + 4);
          if (rest) up.write(Buffer.from(rest, 'latin1'));
          client.pipe(up);
          up.pipe(client);
        });
        up.on('error', () => client.destroy());
      };
      client.on('data', onData);
      client.on('error', () => {});
    });
    await new Promise<void>((r) => fakeProxy.listen(0, '127.0.0.1', () => r()));
    const proxyPort = (fakeProxy.address() as net.AddressInfo).port;

    const { initProxyConfig } = await import('../src/utils/proxy.js');
    initProxyConfig({ enabled: true, url: `http://127.0.0.1:${proxyPort}` });
    try {
      // 1) Object entry viaProxy:true → tunnel egresses through the outbound proxy
      const h1 = await createForwardProxyServer({
        port: 0,
        host: '127.0.0.1',
        caDir: tmpCaDir(),
        bypassHosts: [{ host: 'blocked.example', viaProxy: true }],
        intercept: async () => false,
      });
      const s1 = await connectViaProxy(h1.port, 'blocked.example', 443);
      const echoed = await new Promise<string>((resolve) => {
        s1.once('data', (d: Buffer) => resolve(d.toString()));
        s1.write('ping-through-proxy');
      });
      assert.equal(echoed, 'ping-through-proxy');
      assert.ok(
        proxyConnects.some((l) => l.includes('blocked.example:443')),
        `expected a CONNECT for blocked.example:443, got: ${proxyConnects.join(' | ')}`
      );
      s1.destroy();
      await h1.close();

      // 2) Bare string entry → tunnel stays DIRECT even with the global flag on
      const before = proxyConnects.length;
      const h2 = await createForwardProxyServer({
        port: 0,
        host: '127.0.0.1',
        caDir: tmpCaDir(),
        bypassHosts: ['blocked.example'],
        viaOutboundProxy: true,
        intercept: async () => false,
      });
      const s2 = await connectViaProxy(h2.port, 'blocked.example', 443);
      await new Promise<void>((resolve) => {
        s2.on('close', () => resolve());
        s2.on('error', () => resolve());
        s2.write('x');
        setTimeout(resolve, 5000);
      });
      assert.equal(
        proxyConnects.length,
        before,
        'bare-string bypass entries must NOT egress via the outbound proxy'
      );
      await h2.close();
    } finally {
      initProxyConfig(undefined);
      fakeProxy.close();
      echo.close();
    }
  });
});