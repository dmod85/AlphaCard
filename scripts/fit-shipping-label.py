"""Fit a carrier shipping label onto a 100mm x 150mm page for the Y41BT.

Reads a PDF. Writes a one-or-more page PDF sized for 4x6 thermal stock.
Exits 0 when a label was written, 2 when the file does not look like a
shipping label, 1 on failure.
"""
import sys
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops

MM = 72 / 25.4
PAGE_W_PT = 100 * MM
PAGE_H_PT = 150 * MM
DPI = 203


def page_inches(page):
    w, h = page.get_size()
    return w / 72, h / 72


def is_label_page(w_in, h_in):
    short, long = sorted((w_in, h_in))
    return 3.6 <= short <= 4.4 and 5.5 <= long <= 6.5


def looks_like_label_text(text):
    upper = (text or "").upper()
    if "PACKING SLIP" in upper or "SALES RECORD" in upper:
        return False
    has_carrier = any(token in upper for token in ("USPS", "UPS", "FEDEX", "UNIUNI", "DHL"))
    has_track = "TRACK" in upper or "TRACKING" in upper
    return has_carrier and has_track


def content_bbox(image):
    bg = Image.new("RGB", image.size, (255, 255, 255))
    diff = ImageChops.difference(image.convert("RGB"), bg).convert("L")
    mask = diff.point(lambda p: 255 if p > 18 else 0)
    return mask.getbbox()


def fit_image(image):
    """Scale onto a 100mm x 150mm canvas at 203 dpi, upright."""
    px_w = round(100 / 25.4 * DPI)
    px_h = round(150 / 25.4 * DPI)
    canvas = Image.new("RGB", (px_w, px_h), "white")
    src = image.convert("RGB")
    if src.width > src.height:
        src = src.rotate(90, expand=True)
    margin = round(1.5 / 25.4 * DPI)
    max_w = px_w - margin * 2
    max_h = px_h - margin * 2
    scale = min(max_w / src.width, max_h / src.height)
    resized = src.resize((max(1, round(src.width * scale)), max(1, round(src.height * scale))), Image.Resampling.LANCZOS)
    x = (px_w - resized.width) // 2
    y = (px_h - resized.height) // 2
    canvas.paste(resized, (x, y))
    return canvas


def render(page, scale):
    return page.render(scale=scale).to_pil().convert("RGB")


def pages_to_canvases(pdf, force):
    canvases = []
    for page in pdf:
        w_in, h_in = page_inches(page)
        text = ""
        try:
            text = page.get_textpage().get_text_bounded() or ""
        except Exception:
            text = ""
        labelish = is_label_page(w_in, h_in) or looks_like_label_text(text) or force
        if not labelish:
            continue
        scale = DPI / 72
        image = render(page, scale)
        if not is_label_page(w_in, h_in):
            bbox = content_bbox(image)
            if bbox:
                image = image.crop(bbox)
            # Letter pages from eBay park a 4x6 label in the corner. If the
            # crop is still a full sheet, keep the top-left 4x6 inches.
            if image.width > image.height * 1.15 or (image.width / DPI > 5 and image.height / DPI > 7):
                crop_w = min(image.width, round(4 * DPI))
                crop_h = min(image.height, round(6 * DPI))
                image = image.crop((0, 0, crop_w, crop_h))
        canvases.append(fit_image(image))
    return canvases


def main():
    if len(sys.argv) < 3:
        print("usage: fit-shipping-label.py INPUT.pdf OUTPUT.pdf [--force]", file=sys.stderr)
        return 1
    src = Path(sys.argv[1])
    dest = Path(sys.argv[2])
    force = "--force" in sys.argv[3:]
    if not src.exists():
        print(f"missing {src}", file=sys.stderr)
        return 1
    pdf = pdfium.PdfDocument(str(src))
    canvases = pages_to_canvases(pdf, force)
    if not canvases:
        print("skip")
        return 2
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvases[0].save(dest, "PDF", resolution=DPI, save_all=True, append_images=canvases[1:])
    print(f"label {len(canvases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
