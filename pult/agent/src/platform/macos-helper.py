"""Long-running macOS input helper. CoreGraphics via ctypes, no third-party modules."""
import ctypes
import json
import sys

cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")

def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def mouse(kind, dx=0, dy=0, button=0):
    # kCGEventMouseMoved = 5, LeftDown = 1, LeftUp = 2, RightDown = 3, RightUp = 4, Scroll = 22
    event = cg.CGEventCreate(None)
    location = cg.CGEventGetLocation(event)
    cg.CFRelease(event)
    point = location
    # CGPoint is a struct; treat location as two doubles already inside the return on arm64/x64 via a wrapper.
    event = cg.CGEventCreateMouseEvent(None, kind, point, button)
    cg.CGEventSetIntegerValueField(event, 4, int(dx))  # kCGMouseEventDeltaX is not reliable this way
    cg.CGEventPost(0, event)
    cg.CFRelease(event)

# Simpler and reliable: CGEventCreateMouseEvent with current position plus delta.
class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

cg.CGEventGetLocation.restype = CGPoint
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p

KEYS = {
    "enter": 36, "escape": 53, "tab": 48, "backspace": 51, "space": 49,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "ctrl": 59, "alt": 58, "shift": 56, "win": 55, "meta": 55,
}

def current():
    event = cg.CGEventCreate(None)
    point = cg.CGEventGetLocation(event)
    cg.CFRelease(event)
    return point

def post_mouse(kind, point, button=0):
    event = cg.CGEventCreateMouseEvent(None, kind, point, button)
    cg.CGEventPost(0, event)
    cg.CFRelease(event)

for line in sys.stdin:
    cmd = json.loads(line)
    try:
        op = cmd.get("op")
        if op == "move":
            point = current()
            point.x += float(cmd.get("dx") or 0)
            point.y += float(cmd.get("dy") or 0)
            post_mouse(5, point, 0)
        elif op == "click":
            button = {"left": 0, "right": 1, "middle": 2}.get(cmd.get("button") or "left", 0)
            down, up = (3, 4) if button == 1 else (1, 2)
            point = current()
            for _ in range(int(cmd.get("count") or 1)):
                post_mouse(down, point, button)
                post_mouse(up, point, button)
        elif op == "scroll":
            event = cg.CGEventCreateScrollWheelEvent(None, 0, 2, int(cmd.get("dy") or 0), int(cmd.get("dx") or 0))
            cg.CGEventPost(0, event)
            cg.CFRelease(event)
        elif op == "key":
            code = KEYS.get(cmd["key"])
            if code is None and len(cmd["key"]) == 1:
                # US keyboard virtual key is not the character. Fall through to text on the agent side.
                raise RuntimeError("character")
            event = cg.CGEventCreateKeyboardEvent(None, code, bool(cmd.get("down")))
            cg.CGEventPost(0, event)
            cg.CFRelease(event)
        else:
            raise RuntimeError("unknown")
        reply({"id": cmd.get("id"), "ok": True})
    except Exception as error:  # noqa: BLE001 - helper must keep running
        reply({"id": cmd.get("id"), "ok": False, "error": str(error)})
