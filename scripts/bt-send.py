#!/usr/bin/env python3
"""
bt-send.py <mac> <channel>
Reads binary data from stdin and sends it directly to a Bluetooth RFCOMM device.
Works as a regular user — no rfcomm device file or root required.
"""
import socket
import sys

def main():
    if len(sys.argv) < 3:
        print("Usage: bt-send.py <mac> <channel>", file=sys.stderr)
        sys.exit(1)

    mac = sys.argv[1]
    channel = int(sys.argv[2])
    data = sys.stdin.buffer.read()

    try:
        sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        sock.settimeout(10)
        sock.connect((mac, channel))
        sock.sendall(data)
        sock.close()
        print(f"Sent {len(data)} bytes to {mac} channel {channel}", file=sys.stderr)
    except Exception as e:
        print(f"BT send error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
