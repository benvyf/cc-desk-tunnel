"""Read local, private PktMon/NetLog evidence. Never uploads packet contents.

This focused reader can establish specific leakage, but never certifies that
all possible traffic is absent. Unknown formats and incomplete data are noted.
"""
import collections
import datetime
import ipaddress
import json
import struct
import sys
from pathlib import Path


def options(body, endian):
    offset = 0
    while offset < len(body):
        if offset + 4 > len(body):
            raise ValueError("Short PCAPNG option")
        code, size = struct.unpack_from(endian + "HH", body, offset)
        offset += 4
        if code == 0:
            return
        if offset + size > len(body):
            raise ValueError("Truncated PCAPNG option")
        yield code, body[offset:offset + size]
        offset += (size + 3) & ~3


def read_packets(data):
    offset, endian, interfaces = 0, None, []
    records, issues = [], set()
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("Truncated PCAPNG block")
        if data[offset:offset + 4] == b"\x0a\x0d\x0d\x0a":
            magic = data[offset + 8:offset + 12]
            endian = {b"\x4d\x3c\x2b\x1a": "<", b"\x1a\x2b\x3c\x4d": ">"}.get(magic)
            if endian is None:
                raise ValueError("Invalid section byte order")
            interfaces = []
        if endian is None:
            raise ValueError("Missing PCAPNG section")
        kind, size = struct.unpack_from(endian + "II", data, offset)
        if size < 12 or size % 4 or offset + size > len(data):
            raise ValueError("Invalid PCAPNG block size")
        if struct.unpack_from(endian + "I", data, offset + size - 4)[0] != size:
            raise ValueError("PCAPNG trailing length mismatch")
        body = data[offset + 8:offset + size - 4]
        if kind == 1:
            if len(body) < 8:
                raise ValueError("Short interface")
            link, _, _snap = struct.unpack_from(endian + "HHI", body)
            resolution, time_offset = 1e-6, 0
            for code, value in options(body[8:], endian):
                if code == 9:
                    if len(value) != 1:
                        raise ValueError("Invalid timestamp resolution")
                    power = value[0]
                    resolution = (2 if power & 128 else 10) ** -(power & 127)
                if code == 14:
                    if len(value) != 8:
                        raise ValueError("Invalid timestamp offset")
                    time_offset = struct.unpack(endian + "q", value)[0]
            interfaces.append((link, resolution, time_offset))
            if link not in (1, 101, 228, 229):
                issues.add("Unsupported link type: " + str(link))
        elif kind == 6:
            if len(body) < 20:
                raise ValueError("Short enhanced packet")
            interface, high, low, captured, original = struct.unpack_from(endian + "IIIII", body)
            if interface >= len(interfaces) or captured > original or 20 + captured > len(body):
                raise ValueError("Invalid enhanced packet")
            link, resolution, time_offset = interfaces[interface]
            records.append((((high << 32) | low) * resolution + time_offset, link,
                            body[20:20 + captured], captured < original))
        elif kind == 5:
            if len(body) < 12:
                raise ValueError("Short interface statistics")
            for code, value in options(body[12:], endian):
                # ISB 5 is interface drops, 7 is OS drops. Filter accepts
                # (code 6) and delivered packets (code 8) are not drops.
                if code in (5, 7) and len(value) == 8 and struct.unpack(endian + "Q", value)[0]:
                    issues.add("Nonzero interface/OS drop counter; distinguish packet drops from ETW event loss")
        elif kind in (2, 3):
            issues.add("Untimed/obsolete packet block not decoded")
        offset += size
    return records, sorted(issues)


def decode_ip(packet, link):
    if link == 1:
        if len(packet) < 14:
            raise ValueError("Short Ethernet header")
        ether, offset = struct.unpack_from("!H", packet, 12)[0], 14
        # PktMon can include raw decrypted WLAN frames under link type 1.
        # Decode only data frames with a structurally valid LLC/SNAP header.
        if ether not in (0x800, 0x86DD, 0x8100, 0x88A8) and packet[0] & 0x0F == 8:
            wifi = 24 + (6 if packet[1] & 3 == 3 else 0)
            if packet[0] & 0x80:
                wifi += 2 + (4 if packet[1] & 0x80 else 0)
            if packet[wifi:wifi + 6] == b"\xaa\xaa\x03\0\0\0" and len(packet) >= wifi + 8:
                ether, offset = struct.unpack_from("!H", packet, wifi + 6)[0], wifi + 8
        while ether in (0x8100, 0x88A8):
            if len(packet) < offset + 4:
                raise ValueError("Short VLAN header")
            ether = struct.unpack_from("!H", packet, offset + 2)[0]
            offset += 4
        if ether not in (0x800, 0x86DD):
            return None
        packet = packet[offset:]
    elif link not in (101, 228, 229):
        return None
    if not packet:
        raise ValueError("Missing IP header")
    family = packet[0] >> 4
    if family == 4:
        if len(packet) < 20:
            raise ValueError("Short IPv4 header")
        offset = (packet[0] & 15) * 4
        if offset < 20 or len(packet) < offset:
            raise ValueError("Invalid IPv4 header length")
        protocol = packet[9]
        source, target = packet[12:16], packet[16:20]
        if struct.unpack_from("!H", packet, 6)[0] & 0x1FFF:
            raise ValueError("Noninitial IP fragment not decoded")
    elif family == 6:
        if len(packet) < 40:
            raise ValueError("Short IPv6 header")
        offset, protocol = 40, packet[6]
        source, target = packet[8:24], packet[24:40]
        for _ in range(12):
            if protocol not in (0, 43, 44, 60, 51):
                break
            if len(packet) < offset + 8:
                raise ValueError("Short IPv6 extension")
            following = packet[offset]
            if protocol == 44:
                if struct.unpack_from("!H", packet, offset + 2)[0] & 0xFFF8:
                    raise ValueError("Noninitial IPv6 fragment not decoded")
                length = 8
            else:
                length = (packet[offset + 1] + (2 if protocol == 51 else 1)) * (4 if protocol == 51 else 8)
            offset, protocol = offset + length, following
        else:
            raise ValueError("IPv6 extension chain too long")
    else:
        raise ValueError("Unrecognized IP version")
    result = {"family": family, "src": str(ipaddress.ip_address(source)),
              "dst": str(ipaddress.ip_address(target)), "protocol": protocol}
    if protocol in (6, 17):
        if len(packet) < offset + 8:
            raise ValueError("Short transport header")
        result["sport"], result["dport"] = struct.unpack_from("!HH", packet, offset)
        result["payload"] = packet[offset + 8:] if protocol == 17 else b""
    return result


def endpoint(value):
    host, port = value.rsplit(":", 1)
    return host.strip("[]").split("%")[0], int(port)


def utc(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def probe_query_label(payload, nonce):
    # Prefix truncation can retain the full unique first label even when the
    # domain suffix is incomplete. Do not count responses or capture controls.
    if len(payload) < 13 or payload[2] & 0x80 or struct.unpack_from("!H", payload, 4)[0] == 0:
        return None
    size = payload[12]
    if not 0 < size <= 63 or len(payload) < 13 + size:
        return None
    label = payload[13:13 + size]
    expected = {prefix + nonce.encode() for prefix in (b"rtc-", b"prefetch-", b"native-")}
    return label.decode("ascii") if label in expected else None


def sending_sources(dns_sources, dependencies, sent):
    query_sends = collections.defaultdict(set)
    for source, qname in dns_sources.items():
        pending, visited = [source], set()
        while pending:
            current = pending.pop()
            if current not in visited:
                visited.add(current)
                pending.extend(dependencies.get(current, ()))
        query_sends[qname].update(node for node in visited if sent.get(node, 0) > 0)
    return {key: sorted(value) for key, value in query_sends.items()}


def analyze(directory):
    def read(name):
        return json.loads((directory / name).read_text(encoding="utf-8-sig"))
    run, ready, complete = read("run.json"), read("capture-ready.json"), read("capture-complete.json")
    root, native = read("observed/result.json"), read("observed/native-result.json")
    settings, netlog = read("observed/settings.json"), read("observed/netlog.json")
    for item in (ready, complete, root, settings):
        if item["nonce"] != run["nonce"]:
            raise ValueError("Evidence nonce mismatch")
    started, ended = utc(root["browserStartedAt"]), utc(root["browserEndedAt"])
    coverage = utc(ready["startedAt"]) <= utc(root["positiveStartedAt"]) < started < ended <= utc(complete["endedAt"])
    names = {value: key for key, value in netlog["constants"]["logEventTypes"].items()}
    udp, tcp, queries = {}, set(), set()
    dns_sources, dependencies = {}, collections.defaultdict(set)
    sent = collections.Counter()
    for event in netlog["events"]:
        name, params = names.get(event["type"], ""), event.get("params") or {}
        source = event["source"]["id"]
        dependency = params.get("source_dependency", {}).get("id")
        if dependency is not None:
            dependencies[source].add(dependency)
        if name in ("UDP_CONNECT", "UDP_LOCAL_ADDRESS") and params.get("address"):
            udp.setdefault(source, {})["remote" if name == "UDP_CONNECT" else "local"] = endpoint(params["address"])
        if name == "UDP_BYTES_SENT":
            sent[source] += params.get("byte_count", 0)
        if name == "TCP_CONNECT_ATTEMPT" and params.get("address"):
            tcp.add(params["address"])
        if name == "DNS_TRANSACTION_QUERY" and run["nonce"] in params.get("qname", ""):
            queries.add(params["qname"])
            dns_sources[source] = params["qname"]
    query_sends = sending_sources(dns_sources, dependencies, sent)
    records, issues = read_packets((directory / "capture.pcapng").read_bytes())
    positive, nonce_dns, direct_target, matched_udp = 0, collections.Counter(), 0, collections.Counter()
    decoding_errors, timestamps = collections.Counter(), []
    marker = ("CC_CAPTURE_CONTROL_" + run["nonce"]).encode()
    for timestamp, link, packet, _truncated in records:
        timestamps.append(timestamp)
        try:
            value = decode_ip(packet, link)
        except ValueError as error:
            decoding_errors[str(error)] += 1
            continue
        if not value or value["protocol"] not in (6, 17):
            continue
        if value["protocol"] == 17 and value["dst"] == root["positiveUdp"]["destination"] and value["dport"] == 3478 and value["sport"] == root["positiveUdp"]["sourcePort"] and marker in value["payload"]:
            positive += 1
        if not started <= timestamp <= ended:
            continue
        if value["dst"] == "74.82.201.214" and value["dport"] in (443, 3478):
            direct_target += 1
        if value["protocol"] == 17:
            if value["dport"] == 53 and probe_query_label(value["payload"], run["nonce"]):
                nonce_dns[value["dst"]] += 1
            for source, flow in udp.items():
                local, remote = flow.get("local"), flow.get("remote")
                if local and value["sport"] == local[1] and (
                    local[0] in ("0.0.0.0", "::") or value["src"] == local[0]) and (
                    not remote or (value["dst"], value["dport"]) == remote):
                    matched_udp[str(source)] += 1
    dns = (directory / "dns-events.jsonl").read_text(encoding="utf-8-sig").lower()
    dns_control = root["positiveDnsName"].lower() in dns
    dns_names = {key: settings[key].lower() in dns for key in ("host", "rtcHost", "prefetchHost")}
    known_dns_leak = bool(nonce_dns) or any(query_sends.values())
    return {
        "schema": 1, "nonce": run["nonce"],
        "outcome": "BLOCKED_DNS_LEAK" if known_dns_leak else "REVIEW_REQUIRED",
        "captureCoversBrowserWindow": coverage,
        "nativeFunctionalChecksPassed": root.get("ok") is True and native.get("ok") is True,
        "packetControlObservations": positive, "dnsEtwControlVisible": dns_control,
        "dnsExtractionError": complete.get("dnsExtractionError"),
        "nonceDnsPacketObservationsByResolver": dict(nonce_dns),
        "nonceDnsQueriesInNetLog": sorted(queries), "dnsEtwNamesVisible": dns_names,
        "dnsNetLogSendingSources": query_sends,
        "ownedTargetPacketObservationsWithoutProcessAttribution": direct_target,
        "netLogTcpDestinations": sorted(tcp),
        "netLogUdpFlows": [{"source": key, **value, "sentBytes": sent[key],
                           "packetObservations": matched_udp[str(key)]} for key, value in udp.items()],
        "packetRecords": len(records), "readerIssues": issues, "decodeErrors": dict(decoding_errors),
        "scope": "Specific nonce DNS/UDP observations only; packet observations may include PktMon component duplicates. Owned-target packets alone cannot distinguish background processes. No zero-leakage certification.",
        "limitations": ["Capture loss statistics require manual review.",
                        "No public IPv6 destination was available on the owned VPS.",
                        "This local offline fixture is separate from the prior Ubuntu egress run.",
                        "No Claude requests or login were tested."],
    }


if __name__ == "__main__":
    directory = Path(sys.argv[1]).resolve()
    result = analyze(directory)
    (directory / "capture-analysis.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
