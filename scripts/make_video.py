"""Morsy demo encoder — dark, minimal, startup-launch aesthetic.

Usage: python3 -I scripts/make_video.py demo/manifest.json demo/out.mp4

Manifest items:
  {"type":"title","eyebrow":"MORSY","title":"Describe it. It's built.","sub":"...","hold":3}
  {"type":"chapter","n":"01","title":"Describe it","sub":"...","hold":2}
  {"type":"ui","path":..,"hold":2,"label":"PLANNING","caption":"...","zoom":[1.0,1.04]}   # device-framed UI still, Ken Burns
  {"type":"uiseq","glob":..,"hold":0.9,"label":..,"caption":..}                          # sequence of UI stills
  {"type":"hero","glob":"demo/frames/hero_a_*.jpg","label":..,"caption":..,"fps":30}      # full-bleed 1080p renders
  {"type":"outro","title":"morsy","sub":"github.com/jennhsin-work/morsy","hold":3}
"""
import sys, json, glob, math
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 1920, 1080, 30
BG = (10, 11, 14)
INK = (238, 240, 244); DIM = (138, 143, 156); ACCENT = (120, 160, 255); ACCENT2 = (170, 120, 255)

def font(size, weight="regular"):
    # Helvetica Neue family on macOS (ttc indices: 0 regular, 1 bold, 2 ultralight… vary); fall back gracefully.
    candidates = {
        # HelveticaNeue.ttc indices: 0 Regular · 1 Bold · 7 Light · 10 Medium
        "bold": [("/System/Library/Fonts/HelveticaNeue.ttc", 1), ("/System/Library/Fonts/SFNS.ttf", 0)],
        "medium": [("/System/Library/Fonts/HelveticaNeue.ttc", 10), ("/System/Library/Fonts/HelveticaNeue.ttc", 1)],
        "regular": [("/System/Library/Fonts/HelveticaNeue.ttc", 0), ("/System/Library/Fonts/SFNS.ttf", 0)],
        "light": [("/System/Library/Fonts/HelveticaNeue.ttc", 7), ("/System/Library/Fonts/HelveticaNeue.ttc", 0)],
    }[weight]
    for path, idx in candidates:
        try: return ImageFont.truetype(path, size, index=idx)
        except Exception: continue
    return ImageFont.load_default()

def to_cv(img): return cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR)
def to_pil(frame): return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

def backdrop():
    """Near-black with a soft blue/violet glow top-right and a faint grid — the launch-page look."""
    base = Image.new("RGB", (W, H), BG)
    glow = Image.new("RGB", (W, H), (0, 0, 0)); d = ImageDraw.Draw(glow)
    d.ellipse((W * 0.55, -H * 0.55, W * 1.35, H * 0.45), fill=(26, 34, 70))
    d.ellipse((-W * 0.3, H * 0.6, W * 0.35, H * 1.5), fill=(34, 22, 56))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    base = Image.blend(base, Image.composite(glow, base, Image.new("L", (W, H), 255)), 0.9)
    arr = np.array(base).astype(np.int16) + np.array(glow); base = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(base)
    for x in range(0, W, 96): d.line((x, 0, x, H), fill=(16, 17, 22))
    for y in range(0, H, 96): d.line((0, y, W, y), fill=(16, 17, 22))
    return base

BACK = backdrop()

def text_w(d, s, f): return d.textbbox((0, 0), s, font=f)[2]

def tracked(d, xy, s, f, fill, tracking=0.12):
    """Uppercase eyebrow with letter-spacing."""
    x, y = xy
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill); x += text_w(d, ch, f) + f.size * tracking
    return x

def gradient_text(img, xy, s, f, c1=ACCENT, c2=ACCENT2):
    """Horizontal gradient fill through a text mask."""
    mask = Image.new("L", img.size, 0); ImageDraw.Draw(mask).text(xy, s, font=f, fill=255)
    g = np.zeros((H, W, 3), np.uint8); bb = mask.getbbox() or (0, 0, 1, 1)
    xs = np.linspace(0, 1, max(1, bb[2] - bb[0]))
    for i, c in enumerate(zip(c1, c2)): g[:, bb[0]:bb[2], i] = (c[0] + (c[1] - c[0]) * xs).astype(np.uint8)
    img.paste(Image.fromarray(g), (0, 0), mask)

def card_title(eyebrow, title, sub):
    img = BACK.copy(); d = ImageDraw.Draw(img)
    f_eye, f_title, f_sub = font(26, "medium"), font(96, "bold"), font(34, "light")
    y = H // 2 - 150
    ex = (W - text_w(d, eyebrow, f_eye) * 1.12) // 2; tracked(d, (ex, y), eyebrow, f_eye, ACCENT)
    tw = text_w(d, title, f_title); d.text(((W - tw) // 2, y + 56), title, font=f_title, fill=INK)
    if sub:
        sw = text_w(d, sub, f_sub); d.text(((W - sw) // 2, y + 190), sub, font=f_sub, fill=DIM)
    return to_cv(img)

def card_chapter(n, title, sub):
    img = BACK.copy(); d = ImageDraw.Draw(img)
    f_n, f_title, f_sub = font(30, "medium"), font(84, "bold"), font(32, "light")
    x, y = 180, H // 2 - 120
    tracked(d, (x, y), f"{n}  /  {title.upper()}", f_n, ACCENT, 0.18)
    gradient_text(img, (x, y + 52), title, f_title)
    if sub: d.text((x, y + 170), sub, font=f_sub, fill=DIM)
    # accent rule
    d = ImageDraw.Draw(img); d.rectangle((x, y + 236, x + 120, y + 239), fill=ACCENT)
    return to_cv(img)

def card_outro(title, sub):
    img = BACK.copy(); d = ImageDraw.Draw(img)
    f_t, f_s = font(120, "bold"), font(34, "regular")
    tw = text_w(d, title, f_t); gradient_text(img, ((W - tw) // 2, H // 2 - 110), title, f_t, INK, (200, 205, 220))
    d = ImageDraw.Draw(img); sw = text_w(d, sub, f_s); d.text(((W - sw) // 2, H // 2 + 40), sub, font=f_s, fill=DIM)
    return to_cv(img)

def lower_third(frame, label, caption):
    if not caption and not label: return frame
    img = to_pil(frame); d = ImageDraw.Draw(img, "RGBA")
    f_l, f_c = font(20, "medium"), font(30, "regular")
    pad, x, y = 26, 72, H - 150
    cw = max(text_w(d, caption or "", f_c), text_w(d, (label or "") , f_l) * 1.2)
    d.rounded_rectangle((x - pad, y - pad + 6, x + cw + pad, y + 86), radius=14, fill=(10, 11, 14, 215), outline=(60, 64, 78, 255), width=1)
    d.rectangle((x - pad, y - pad + 6, x - pad + 4, y + 86), fill=ACCENT)
    if label: tracked(d, (x, y), label.upper(), f_l, ACCENT, 0.16)
    if caption: d.text((x, y + 32), caption, font=f_c, fill=INK)
    return to_cv(img)

def device_frame(path, zoom=1.0):
    """UI still inside a rounded, shadowed window on the backdrop; zoom > 1 crops in slightly (Ken Burns)."""
    src = Image.open(path).convert("RGB")
    # crop for zoom around the centre
    if zoom > 1:  # crop anchored to the top edge so the menu bar never leaves the frame
        w, h = src.size; cw, ch = int(w / zoom), int(h / zoom); src = src.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, ch))
    fw, fh = int(W * 0.88), int(H * 0.80)
    s = min(fw / src.width, fh / src.height); win = src.resize((int(src.width * s), int(src.height * s)), Image.LANCZOS)
    img = BACK.copy()
    x, y = (W - win.width) // 2, 48
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); ImageDraw.Draw(shadow).rounded_rectangle((x - 6, y + 18, x + win.width + 6, y + win.height + 30), radius=22, fill=(0, 0, 0, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(28)); img.paste(shadow, (0, 0), shadow)
    mask = Image.new("L", win.size, 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, win.width - 1, win.height - 1), radius=16, fill=255)
    img.paste(win, (x, y), mask)
    ImageDraw.Draw(img).rounded_rectangle((x, y, x + win.width - 1, y + win.height - 1), radius=16, outline=(70, 74, 88), width=1)
    return to_cv(img)

def full_bleed(path):
    src = cv2.imread(path); h, w = src.shape[:2]; s = max(W / w, H / h)
    r = cv2.resize(src, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    y0, x0 = (r.shape[0] - H) // 2, (r.shape[1] - W) // 2; return r[y0:y0 + H, x0:x0 + W]

def vignette(frame, strength=0.35):
    if not hasattr(vignette, "mask"):
        yy, xx = np.mgrid[0:H, 0:W]; rr = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        vignette.mask = np.clip(1 - strength * np.clip(rr - 0.55, 0, 1.2), 0, 1)[..., None]
    return (frame * vignette.mask).astype(np.uint8)

out = cv2.VideoWriter(sys.argv[2], cv2.VideoWriter_fourcc(*"avc1"), FPS, (W, H))
assert out.isOpened(), "avc1 encoder unavailable"
last = None
ease = lambda t: 0.5 - 0.5 * math.cos(math.pi * t)

def emit(frame, seconds):
    global last
    for _ in range(max(1, int(round(seconds * FPS)))): out.write(frame)
    last = frame

def crossfade(a, b, seconds=0.5):
    n = int(seconds * FPS)
    for i in range(1, n + 1): t = ease(i / n); out.write(cv2.addWeighted(a, 1 - t, b, t, 0))

def fade_from_black(frame, seconds=0.8):
    n = int(seconds * FPS); black = np.zeros_like(frame)
    for i in range(1, n + 1): out.write(cv2.addWeighted(black, 1 - ease(i / n), frame, ease(i / n), 0))

def ken_burns(path, seconds, z0, z1, label, caption):
    n = int(seconds * FPS)
    for i in range(n):
        z = z0 + (z1 - z0) * ease(i / max(1, n - 1)); f = lower_third(device_frame(path, z), label, caption)
        if i == 0 and last is not None: crossfade(last, f, 0.45)
        out.write(f)
    globals()["last"] = f

for item in json.load(open(sys.argv[1])):
    t = item["type"]
    if t == "title":
        f = card_title(item.get("eyebrow", ""), item["title"], item.get("sub", "")); fade_from_black(f); emit(f, item.get("hold", 3))
    elif t == "chapter":
        f = card_chapter(item["n"], item["title"], item.get("sub", "")); crossfade(last, f, 0.5); emit(f, item.get("hold", 2.2))
    elif t == "ui":
        z = item.get("zoom", [1.0, 1.03]); ken_burns(item["path"], item.get("hold", 2.2), z[0], z[1], item.get("label"), item.get("caption"))
    elif t == "uiseq":
        files = sorted(glob.glob(item["glob"]))
        for i, p in enumerate(files):
            f = lower_third(device_frame(p, 1.0), item.get("label"), item.get("caption"))
            if i == 0: crossfade(last, f, 0.45)
            else: crossfade(last, f, 0.18)
            emit(f, item.get("hold", 0.9))
    elif t == "hero":
        files = sorted(glob.glob(item["glob"])); fps = item.get("fps", FPS)
        for i, p in enumerate(files):
            f = lower_third(vignette(full_bleed(p)), item.get("label"), item.get("caption"))
            if i == 0: crossfade(last, f, 0.6)
            for _ in range(max(1, round(FPS / fps))): out.write(f)
            last = f
    elif t == "outro":
        f = card_outro(item["title"], item.get("sub", "")); crossfade(last, f, 0.7); emit(f, item.get("hold", 3))
        n = int(1.0 * FPS); black = np.zeros_like(f)
        for i in range(1, n + 1): out.write(cv2.addWeighted(f, 1 - ease(i / n), black, ease(i / n), 0))
out.release(); print("wrote", sys.argv[2])
