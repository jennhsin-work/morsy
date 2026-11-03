"""Assemble the Morsy demo video from captured frames with OpenCV.

manifest.json: [{"type":"card","title":..,"sub":..,"hold":2.5},
                {"type":"frame","path":..,"hold":0.6,"caption":..},
                {"type":"seq","glob":"demo/frames/turn_*.jpg","fps":30,"caption":..}]
"""
import cv2, json, sys, glob, numpy as np
W, H, FPS = 1280, 720, 30
out = cv2.VideoWriter(sys.argv[2] if len(sys.argv) > 2 else "demo/morsy-demo.mp4", cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
BG = (36, 36, 36)

def fit(img):
    h, w = img.shape[:2]; s = min(W / w, H / h); nw, nh = int(w * s), int(h * s)
    img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    canvas = np.full((H, W, 3), BG, np.uint8); x, y = (W - nw) // 2, (H - nh) // 2
    canvas[y:y + nh, x:x + nw] = img; return canvas

def caption(frame, text):
    if not text: return frame
    f = frame.copy(); (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
    x, y = (W - tw) // 2, H - 36
    cv2.rectangle(f, (x - 14, y - th - 12), (x + tw + 14, y + 10), (20, 20, 20), -1)
    cv2.putText(f, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (235, 235, 235), 2, cv2.LINE_AA); return f

def card(title, sub, hold):
    f = np.full((H, W, 3), (28, 28, 28), np.uint8)
    (tw, th), _ = cv2.getTextSize(title, cv2.FONT_HERSHEY_DUPLEX, 1.8, 3)
    cv2.putText(f, title, ((W - tw) // 2, H // 2 - 10), cv2.FONT_HERSHEY_DUPLEX, 1.8, (240, 240, 240), 3, cv2.LINE_AA)
    if sub:
        (sw, sh), _ = cv2.getTextSize(sub, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
        cv2.putText(f, sub, ((W - sw) // 2, H // 2 + 50), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (170, 170, 170), 2, cv2.LINE_AA)
    return f, hold

def emit(frame, seconds):
    for _ in range(max(1, int(round(seconds * FPS)))): out.write(frame)

def crossfade(a, b, seconds=0.4):
    n = int(seconds * FPS)
    for i in range(1, n + 1): out.write(cv2.addWeighted(a, 1 - i / n, b, i / n, 0))

last = None
for item in json.load(open(sys.argv[1])):
    if item["type"] == "card":
        f, hold = card(item["title"], item.get("sub", ""), item.get("hold", 2.5))
        if last is not None: crossfade(last, f)
        emit(f, hold); last = f
    elif item["type"] == "frame":
        img = cv2.imread(item["path"]);
        if img is None: print("missing", item["path"]); continue
        f = caption(fit(img), item.get("caption"))
        if last is not None and item.get("fade", True): crossfade(last, f, 0.25)
        emit(f, item.get("hold", 0.6)); last = f
    elif item["type"] == "seq":
        files = sorted(glob.glob(item["glob"])); fps = item.get("fps", FPS); hold = 1 / fps
        for i, p in enumerate(files):
            img = cv2.imread(p)
            if img is None: continue
            f = caption(fit(img), item.get("caption"))
            if i == 0 and last is not None: crossfade(last, f, 0.3)
            emit(f, hold); last = f
out.release(); print("wrote", sys.argv[2] if len(sys.argv) > 2 else "demo/morsy-demo.mp4")
