"""Synthetic evidence-reader checks; no network or capture is started."""
import importlib.util
import ipaddress
import struct
import unittest

from pathlib import Path

spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("analyze-browser-capture.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def block(kind, body, endian="<"):
    size = 12 + len(body)
    return struct.pack(endian + "II", kind, size) + body + struct.pack(endian + "I", size)


def fixture(packet, endian="<", resolution=6, link=101):
    section = block(0x0A0D0D0A, struct.pack(endian + "IHHq", 0x1A2B3C4D, 1, 0, -1), endian)
    interface = block(1, struct.pack(endian + "HHI", link, 0, 128) +
                      struct.pack(endian + "HH", 9, 1) + bytes([resolution, 0, 0, 0]), endian)
    ticks = 2 * (2 ** (resolution & 127) if resolution & 128 else 10 ** resolution)
    body = struct.pack(endian + "IIIII", 0, ticks >> 32, ticks & 0xFFFFFFFF, len(packet), len(packet))
    body += packet + b"\0" * (-len(packet) % 4)
    return section + interface + block(6, body, endian)


class ReaderTests(unittest.TestCase):
    def test_dns_query_excludes_delayed_positive_control_and_response(self):
        nonce = "a" * 24
        header = struct.pack("!HHHHHH", 1, 0x100, 1, 0, 0, 0)
        def question(prefix):
            label = (prefix + nonce).encode()
            return header + bytes([len(label)]) + label
        self.assertEqual(capture.probe_query_label(question("rtc-"), nonce), "rtc-" + nonce)
        self.assertIsNone(capture.probe_query_label(question("capture-"), nonce))
        response = bytearray(question("rtc-"))
        response[2] |= 0x80
        self.assertIsNone(capture.probe_query_label(response, nonce))
        self.assertIsNone(capture.probe_query_label(question("rtc-")[:-1], nonce))

    def test_same_name_keeps_all_dns_transactions_and_ignores_unrelated_send(self):
        self.assertEqual(capture.sending_sources(
            {1: "rtc.example.test", 2: "rtc.example.test", 3: "unsent.example.test"},
            {1: {10}, 2: {20}, 3: {30}, 30: {3}},
            {10: 63, 20: 63, 99: 500}
        ), {"rtc.example.test": [10, 20], "unsent.example.test": []})

    def test_endian_and_timestamp_resolution(self):
        for endian in ("<", ">"):
            for resolution in (6, 9, 0x80 | 10):
                records, issues = capture.read_packets(fixture(b"\x45" + b"\0" * 39, endian, resolution))
                self.assertEqual(issues, [])
                self.assertEqual(records[0][0], 2.0)

    def test_rejects_truncated_block(self):
        with self.assertRaises(ValueError):
            capture.read_packets(fixture(b"\0" * 40)[:-1])

    def test_rejects_unrecognized_link(self):
        _, issues = capture.read_packets(fixture(b"\0" * 40, link=999))
        self.assertTrue(issues)

    def test_ipv4_udp(self):
        udp = struct.pack("!HHHH", 50000, 53, 12, 0) + b"test"
        packet = bytearray(20)
        packet[0], packet[9] = 0x45, 17
        packet[2:4] = struct.pack("!H", 32)
        packet[12:16] = ipaddress.ip_address("192.0.2.1").packed
        packet[16:20] = ipaddress.ip_address("192.0.2.53").packed
        parsed = capture.decode_ip(bytes(packet) + udp, 101)
        self.assertEqual((parsed["sport"], parsed["dport"], parsed["payload"]), (50000, 53, b"test"))

    def test_ethernet_ipv6_udp(self):
        udp = struct.pack("!HHHH", 50001, 53, 12, 0) + b"test"
        packet = bytearray(40)
        packet[0], packet[6] = 0x60, 17
        packet[4:6] = struct.pack("!H", len(udp))
        packet[8:24] = ipaddress.ip_address("fe80::2").packed
        packet[24:40] = ipaddress.ip_address("fe80::1").packed
        parsed = capture.decode_ip(b"\0" * 12 + b"\x86\xdd" + bytes(packet) + udp, 1)
        self.assertEqual((parsed["dst"], parsed["payload"]), ("fe80::1", b"test"))

    def test_short_header_is_not_silent_success(self):
        with self.assertRaises(ValueError):
            capture.decode_ip(b"\x60" + b"\0" * 10, 101)

    def test_pktmon_raw_wifi_inside_ethernet_interface(self):
        # PktMon's converted interface declares Ethernet even for WLAN data
        # frames. Require an exact LLC/SNAP header before treating it as IP.
        packet = bytearray(20)
        packet[0], packet[9] = 0x45, 17
        packet[12:16] = ipaddress.ip_address("192.0.2.1").packed
        packet[16:20] = ipaddress.ip_address("192.0.2.53").packed
        udp = struct.pack("!HHHH", 50000, 53, 12, 0) + b"test"
        wifi = b"\x08\x01" + b"\0" * 22 + b"\xaa\xaa\x03\0\0\0\x08\0"
        parsed = capture.decode_ip(wifi + packet + udp, 1)
        self.assertEqual(parsed["payload"], b"test")


if __name__ == "__main__":
    unittest.main()
