import type net from 'node:net';

/**
 * Bidirectional byte relay between two sockets with backpressure.
 *
 * Two Bun node:net/tls quirks are load-bearing here (verified on 1.3.14):
 *  - `socket.pipe()` FROM a TLSSocket does not flush already-buffered data —
 *    an explicit 'data' relay is used instead;
 *  - a previously `pause()`d stream does NOT auto-flow when a 'data' listener
 *    attaches — `resume()` must be called explicitly.
 */
export function splice(a: net.Socket, b: net.Socket): void {
  a.on('data', (d: Buffer) => {
    if (!b.write(d)) {
      a.pause();
      b.once('drain', () => a.resume());
    }
  });
  b.on('data', (d: Buffer) => {
    if (!a.write(d)) {
      b.pause();
      a.once('drain', () => b.resume());
    }
  });
  a.on('end', () => {
    try {
      b.end();
    } catch {}
  });
  b.on('end', () => {
    try {
      a.end();
    } catch {}
  });
  a.on('error', () => {
    try {
      b.destroy();
    } catch {}
  });
  b.on('error', () => {
    try {
      a.destroy();
    } catch {}
  });
  a.resume();
  b.resume();
}