"""Bounded, dummy-only owned HTTP peer behind the existing nginx TLS endpoint."""
import datetime
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

PAGE = b'''<!doctype html><meta charset="utf-8"><title>CC Owned Egress Check</title><link rel="icon" href="data:,">
<h1>CC Owned Egress Check</h1><p>Dummy content for remote egress verification.</p>
<input id="message" value="dummy text"><a id="download" href="download?id=owned-download">Download</a>
<a id="next" href="next" target="_blank">Next page</a><pre id="result"></pre>
<script>
window.ownedCheck = async id => {
 const result = await (await fetch('marker?kind=page&id='+id)).json();
 const upload = await (await fetch('upload?id='+id,{method:'POST',body:'cc-dummy-upload:'+id})).json();
 document.querySelector('#result').textContent=JSON.stringify({result,upload});
 return {result,upload};
};
</script>'''


def make_server(prefix, port=18790, record=None):
    if not re.fullmatch(r'/_cc-egress-test/[a-f0-9]{32}/', prefix):
        raise ValueError('Invalid dedicated prefix')
    record = record or (lambda value: print(json.dumps(value), flush=True))

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        block_on_close = False
        gate = threading.BoundedSemaphore(8)
        lock = threading.Lock()
        count = 0

        def process_request(self, request, address):
            if not self.gate.acquire(blocking=False):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, address)
            except BaseException:
                self.gate.release()
                raise

        def process_request_thread(self, request, address):
            try:
                super().process_request_thread(request, address)
            finally:
                self.gate.release()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'CC-Owned-Lab'
        sys_version = ''

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

        def reply(self, status, body=b'', content_type='text/plain; charset=utf-8', headers=None):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def route(self):
            with self.server.lock:
                self.server.count += 1
                if self.server.count > 256:
                    self.reply(503)
                    return None
            if len(self.path) > 1024:
                self.reply(414)
                return None
            parsed = urlsplit(self.path)
            if not parsed.path.startswith(prefix):
                self.reply(404)
                return None
            route = parsed.path[len(prefix):]
            if route not in ('', 'next', 'marker', 'download', 'upload', 'upload-hold', 'worker.js', 'sw.js', 'ws'):
                self.reply(404)
                return None
            identifier = parse_qs(parsed.query).get('id', ['none'])[0]
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', identifier):
                self.reply(400)
                return None
            return route, identifier

        def event(self, route, identifier, body=b''):
            value = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                     'method': self.command, 'route': route, 'id': identifier,
                     'source': self.headers.get('X-CC-Lab-Source', '')[:64],
                     'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
            record(value)
            return value

        def do_GET(self):
            target = self.route()
            if target is None:
                return
            route, identifier = target
            if route == 'ws':
                self.websocket(identifier)
                return
            value = self.event(route, identifier)
            if route in ('', 'next'):
                self.reply(200, PAGE, 'text/html; charset=utf-8')
            elif route == 'download':
                self.reply(200, ('cc-owned-download:' + identifier + '\n').encode(),
                           headers={'Content-Disposition': 'attachment; filename="cc-egress-check.txt"'})
            elif route in ('worker.js', 'sw.js'):
                if route == 'worker.js':
                    body = b"fetch('marker?id=dedicated-worker').then(r=>r.json()).then(r=>postMessage(r.id));"
                else:
                    body = b"self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.waitUntil(fetch('marker?id=service-worker').then(r=>r.json()).then(r=>e.source.postMessage(r.id))));"
                self.reply(200, body, 'application/javascript', {'Service-Worker-Allowed': prefix})
            elif route == 'marker':
                self.reply(200, json.dumps(value).encode(), 'application/json')
            else:
                self.reply(405)

        def websocket(self, identifier):
            try:
                key = self.headers.get('Sec-WebSocket-Key', '')
                if (self.headers.get('Upgrade', '').lower() != 'websocket' or
                        'upgrade' not in [value.strip() for value in self.headers.get('Connection', '').lower().split(',')] or
                        self.headers.get('Sec-WebSocket-Version') != '13' or
                        self.headers.get('Origin') not in (None, 'https://api.ghostapi.org') or
                        len(base64.b64decode(key, validate=True)) != 16):
                    self.reply(400)
                    return
            except ValueError:
                self.reply(400)
                return
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode())
            self.end_headers()
            self.close_connection = True
            def close_frame(code):
                self.wfile.write(b'\x88\x02' + code.to_bytes(2, 'big'))
                self.wfile.flush()
            try:
                head = self.rfile.read(2)
                if len(head) != 2:
                    return
                first, second = head
                if first not in (0x81, 0x82, 0x88) or not second & 0x80:
                    close_frame(1002)
                    return
                size = second & 0x7f
                if size == 127:
                    close_frame(1009)
                    return
                if size == 126:
                    extended = self.rfile.read(2)
                    if len(extended) != 2:
                        return
                    size = int.from_bytes(extended, 'big')
                    if size < 126:
                        close_frame(1002)
                        return
                if size > 4096:
                    close_frame(1009)
                    return
                mask = self.rfile.read(4)
                data = self.rfile.read(size)
                if len(mask) != 4 or len(data) != size:
                    return
                data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
                if first == 0x88:
                    close_frame(1000)
                    return
                if first == 0x81:
                    try:
                        data.decode('utf-8')
                    except UnicodeDecodeError:
                        close_frame(1007)
                        return
                self.event('ws', identifier, data)
                length = bytes([size]) if size < 126 else b'\x7e' + size.to_bytes(2, 'big')
                self.wfile.write(bytes([first]) + length + data)
                close_frame(1000)
            except OSError:
                return

        def do_POST(self):
            target = self.route()
            if target is None:
                return
            route, identifier = target
            if route not in ('upload', 'upload-hold'):
                self.reply(405)
                return
            if self.headers.get('Origin') not in (None, 'https://api.ghostapi.org'):
                self.reply(403)
                return
            sizes = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(sizes) != 1 or not sizes[0].isdigit():
                self.reply(411)
                return
            size = int(sizes[0])
            if size > 65536:
                self.reply(413)
                return
            body = self.rfile.read(size)
            if len(body) != size:
                self.reply(400)
                return
            value = self.event(route, identifier, body)
            if route == 'upload-hold':
                time.sleep(8)
            self.reply(200, json.dumps(value).encode(), 'application/json')

    return Server(('127.0.0.1', port), Handler)


if __name__ == '__main__':
    server = make_server(sys.argv[1])
    timer = threading.Timer(1200, server.shutdown)
    timer.daemon = True
    timer.start()
    print('OWNED_SITE_READY', flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        timer.cancel()
        server.server_close()
