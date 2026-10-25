import importlib.util
import json
from pathlib import Path
import threading
import socket
import base64
import os
import unittest
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('owned_site', Path(__file__).with_name('owned-egress-site.py'))
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.prefix = '/_cc-egress-test/' + 'a' * 32 + '/'
        self.events = []
        self.server = site.make_server(self.prefix, port=0, record=self.events.append)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, suffix='', data=None, headers=None):
        req = urllib.request.Request(self.url + self.prefix + suffix, data=data, headers=headers or {})
        return urllib.request.urlopen(req, timeout=3)

    def test_owned_page_and_download_have_no_external_resources(self):
        with self.request() as response:
            body = response.read().decode()
            self.assertIn('CC Owned Egress Check', body)
            self.assertNotIn('https://', body)
        with self.request('download?id=owned-test') as response:
            self.assertEqual(response.read(), b'cc-owned-download:owned-test\n')
            self.assertIn('attachment', response.headers['Content-Disposition'])

    def test_dummy_upload_returns_digest_and_logs_metadata_only(self):
        with self.request('upload?id=owned-test', b'dummy-private-body', {'X-CC-Lab-Source': '203.0.113.8'}) as response:
            result = json.load(response)
            self.assertEqual(result['bytes'], 18)
            self.assertEqual(result['source'], '203.0.113.8')
        self.assertNotIn('dummy-private-body', json.dumps(self.events))
        self.assertEqual(self.events[-1]['bytes'], 18)

    def test_unknown_paths_other_origins_and_large_bodies_are_rejected(self):
        for url, data, headers, expected in [
            (self.url + '/etc/passwd', None, {}, 404),
            (self.url + self.prefix + '../other', None, {}, 404),
            (self.url + self.prefix + 'upload', b'dummy', {'Origin': 'https://foreign.invalid'}, 403),
            (self.url + self.prefix + 'upload', b'x' * 65537, {}, 413),
        ]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=3)
            self.assertEqual(error.exception.code, expected)
            error.exception.close()

    def websocket(self):
        conn = socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3)
        reader = conn.makefile('rb')
        key = base64.b64encode(os.urandom(16)).decode()
        conn.sendall(('GET ' + self.prefix + 'ws?id=owned-ws HTTP/1.1\r\nHost: owned\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n').encode())
        status = reader.readline()
        if b'101' not in status:
            reader.close()
            conn.close()
        self.assertIn(b'101', status)
        while reader.readline() != b'\r\n':
            pass
        return conn, reader

    def test_websocket_echoes_one_bounded_masked_frame(self):
        conn, reader = self.websocket()
        try:
            payload = b'cc-dummy-ws'
            mask = b'abcd'
            conn.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(payload)))
            self.assertEqual(reader.read(2), bytes([0x81, len(payload)]))
            self.assertEqual(reader.read(len(payload)), payload)
        finally:
            reader.close()
            conn.close()

    def test_websocket_rejects_unmasked_and_oversized_frames(self):
        for frame, code in ((b'\x81\x01x', 1002), (b'\x81\xfe\x10\x01', 1009)):
            conn, reader = self.websocket()
            try:
                conn.sendall(frame)
                self.assertEqual(reader.read(4), b'\x88\x02' + code.to_bytes(2, 'big'))
            finally:
                reader.close()
                conn.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
