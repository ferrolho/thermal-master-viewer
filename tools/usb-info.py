#!/usr/bin/env python3
"""Dump the camera's USB descriptors, and say whether WebUSB can drive it.

The viewer needs none of this. It is here for one job: when the browser's
device picker shows nothing, this tells you whether the problem is the OS not
seeing the camera, or the camera exposing an interface class the browser is
not allowed to claim.

    pip install pyusb        # plus libusb: brew install libusb
    python3 tools/usb-info.py
    python3 tools/usb-info.py --all      # every USB device, not just this one
"""

from __future__ import annotations

import argparse
import sys

VID = 0x3474
MODELS = {0x45A2: "P3 (256x192)", 0x45C2: "P1 (160x120)"}

# WebUSB will not let a page claim these; anything else is fair game.
# See https://wicg.github.io/webusb/ — "protected interface classes".
PROTECTED = {
    0x01: "audio",
    0x03: "HID",
    0x08: "mass storage",
    0x0B: "smart card",
    0x0E: "video",
    0x10: "audio/video",
    0xE0: "wireless",
}

TRANSFER = ("control", "isochronous", "bulk", "interrupt")


def describe(dev) -> bool:
    """Print one device. Returns True if WebUSB can claim all its interfaces."""
    model = MODELS.get(dev.idProduct, "unknown model")
    print(f"\n  {dev.idVendor:#06x}:{dev.idProduct:#06x}  {model}")

    for attr in ("manufacturer", "product", "serial_number"):
        try:
            print(f"      {attr:14} {getattr(dev, attr)}")
        except Exception as exc:
            print(f"      {attr:14} <unreadable: {exc}>")

    claimable = True
    for conf in dev:
        print(f"      configuration {conf.bConfigurationValue}")
        for intf in conf:
            cls = intf.bInterfaceClass
            if cls in PROTECTED:
                label, note = PROTECTED[cls], "  <-- WebUSB cannot claim this"
                claimable = False
            else:
                label = "vendor-specific" if cls == 0xFF else "class %#04x" % cls
                note = ""
            print(
                f"        interface {intf.bInterfaceNumber} alt {intf.bAlternateSetting}: "
                f"class={cls:#04x} ({label}) subclass={intf.bInterfaceSubClass:#04x}{note}"
            )
            for ep in intf:
                way = "IN " if ep.bEndpointAddress & 0x80 else "OUT"
                print(
                    f"            endpoint {ep.bEndpointAddress:#04x} {way} "
                    f"{TRANSFER[ep.bmAttributes & 3]:9} max={ep.wMaxPacketSize}"
                )
    return claimable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--all", action="store_true", help="list every USB device")
    args = parser.parse_args()

    try:
        import usb.core
    except ImportError:
        print("pyusb is not installed:  pip install pyusb", file=sys.stderr)
        return 1

    if args.all:
        for dev in usb.core.find(find_all=True):
            try:
                name = dev.product
            except Exception:
                name = "?"
            print(f"  {dev.idVendor:#06x}:{dev.idProduct:#06x}  {name}")
        return 0

    found = list(usb.core.find(find_all=True, idVendor=VID))
    if not found:
        print(f"\n  No Thermal Master device (vendor {VID:#06x}) found.")
        print(f"  libusb sees {len(list(usb.core.find(find_all=True)))} USB device(s); "
              "run with --all to list them.")
        print(
            "\n  If the camera is plugged in but absent here, the OS has not attached\n"
            "  it. On macOS compare these two:\n"
            "      ioreg -p IOUSB -w 0 | grep -i p3                        # on the bus?\n"
            "      ioreg -p IOService -w 0 -c IOUSBHostDevice | grep -i p3  # published?\n"
            "  Present in the first but not the second (marked '!registered, !matched')\n"
            "  means macOS never finished attaching it, and nothing in userspace can\n"
            "  reach it. Unplug for ~10s and plug directly into a port, no hub. Try the\n"
            "  other port. Reboot if it stays stuck.\n"
            "  On Linux, check permissions with a udev rule for the vendor id."
        )
        return 1

    ok = all(describe(dev) for dev in found)
    print(
        "\n  All interfaces are claimable by WebUSB — the viewer should work."
        if ok
        else "\n  At least one interface is a protected class, so WebUSB is blocked."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
