import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

// An ordinary RFB 3.8 peer: solid pixels and recorded human key/pointer events, no website or browser.
export async function offlineFramebuffer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const keys: { down: boolean; symbol: number }[] = [];
  const pointers: number[] = [];
  let connections = 0;
  let mode: 'none' | 'password' | 'silent' = 'none';
  server.on('connection', (ws) => {
    connections++;
    const security = mode;
    if (security === 'silent') return;
    let phase = 0,
      bytes = Buffer.alloc(0),
      sent = false;
    let format = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
    ws.send(Buffer.from('RFB 003.008\n'));
    ws.on('message', (data) => {
      bytes = Buffer.concat([bytes, Buffer.from(data as Buffer)]);
      for (;;) {
        let length = 0;
        if (phase === 0) {
          length = 12;
          if (bytes.length < length) return;
          ws.send(Buffer.from([1, security === 'password' ? 2 : 1]));
          phase++;
        } else if (phase === 1) {
          length = 1;
          if (bytes.length < length) return;
          if (security === 'password') {
            ws.send(Buffer.alloc(16, 1));
            return;
          }
          ws.send(Buffer.alloc(4));
          phase++;
        } else if (phase === 2) {
          length = 1;
          if (bytes.length < length) return;
          const name = Buffer.from('Offline framebuffer');
          const init = Buffer.alloc(24);
          init.writeUInt16BE(320, 0);
          init.writeUInt16BE(180, 2);
          format.copy(init, 4);
          init.writeUInt32BE(name.length, 20);
          ws.send(Buffer.concat([init, name]));
          phase++;
        } else {
          if (!bytes.length) return;
          const type = bytes[0];
          if (type === 0) length = 20;
          else if (type === 2) {
            if (bytes.length < 4) return;
            length = 4 + bytes.readUInt16BE(2) * 4;
          } else if (type === 3) length = 10;
          else if (type === 4) length = 8;
          else if (type === 5) length = 6;
          else if (type === 6) {
            if (bytes.length < 8) return;
            length = 8 + bytes.readUInt32BE(4);
          } else throw new Error(`Unexpected offline RFB message ${type}`);
          if (bytes.length < length) return;
          if (type === 0) format = Buffer.from(bytes.subarray(4, 20));
          if (type === 4) keys.push({ down: bytes[1] === 1, symbol: bytes.readUInt32BE(4) });
          if (type === 5) pointers.push(bytes[1]);
          if (type === 3 && !sent) {
            sent = true;
            const header = Buffer.alloc(16);
            header[3] = 1;
            header.writeUInt16BE(320, 8);
            header.writeUInt16BE(180, 10);
            const pixels = Buffer.alloc(320 * 180 * 4);
            const color = (0x33 << format[10]) | (0x77 << format[11]) | (0xaa << format[12]);
            for (let offset = 0; offset < pixels.length; offset += 4)
              if (format[2]) pixels.writeUInt32BE(color >>> 0, offset);
              else pixels.writeUInt32LE(color >>> 0, offset);
            ws.send(Buffer.concat([header, pixels]));
          }
        }
        bytes = bytes.subarray(length);
      }
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    keys,
    pointers,
    connections: () => connections,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    disconnect: () => {
      for (const socket of server.clients) socket.close();
    },
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
