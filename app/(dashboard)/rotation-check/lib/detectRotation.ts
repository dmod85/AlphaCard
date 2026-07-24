// Client-side skew detection for card photos shot on a plain background.
// Same idea as cv2.minAreaRect: find the foreground blob, then search for the
// rotation angle that makes its bounding box smallest (i.e. squares it up).

export const ROTATION_THRESHOLD_DEG = 0.6;

export interface SkewDetection {
  angleDeg: number;
  confidence: number; // 0-1, rough signal based on how much of the frame is foreground
  backgroundColor: string; // css rgb(), sampled from the corners — reused when padding rotated output
  foregroundFraction: number;
}

interface RGB { r: number; g: number; b: number }

function sampleBackgroundColor(data: Uint8ClampedArray, width: number, height: number): RGB {
  const patch = Math.max(2, Math.round(Math.min(width, height) * 0.03));
  const corners: [number, number][] = [
    [0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch],
  ];
  let r = 0, g = 0, b = 0, n = 0;
  for (const [ox, oy] of corners) {
    for (let y = oy; y < oy + patch; y++) {
      for (let x = ox; x < ox + patch; x++) {
        const i = (y * width + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

function colorDistance(r: number, g: number, b: number, bg: RGB): number {
  const dr = r - bg.r, dg = g - bg.g, db = b - bg.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Angle (deg) that minimizes the axis-aligned bounding box of `points` when rotated about their centroid. */
function minAreaAngle(points: number[], cx: number, cy: number, from: number, to: number, stepDeg: number): number {
  let bestAngle = from;
  let bestArea = Infinity;
  for (let a = from; a <= to; a += stepDeg) {
    const rad = (a * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let p = 0; p < points.length; p += 2) {
      const dx = points[p] - cx, dy = points[p + 1] - cy;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < bestArea) { bestArea = area; bestAngle = a; }
  }
  return bestAngle;
}

/**
 * Detects how far off-square an image is. Expects the photographed object to
 * sit on a roughly uniform background (sampled from the four corners) so it
 * can be separated from the background by color distance.
 */
export function detectSkew(canvas: HTMLCanvasElement, opts: { colorThreshold?: number } = {}): SkewDetection {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const { data } = ctx.getImageData(0, 0, width, height);

  const bg = sampleBackgroundColor(data, width, height);
  const colorThreshold = opts.colorThreshold ?? 45;
  const backgroundColor = `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`;

  // Sample on a grid capped around ~120x120 cells so this stays fast per image.
  const gridTarget = 120;
  const step = Math.max(1, Math.round(Math.min(width, height) / gridTarget));

  const points: number[] = [];
  let sampled = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      sampled++;
      const i = (y * width + x) * 4;
      if (colorDistance(data[i], data[i + 1], data[i + 2], bg) > colorThreshold) {
        points.push(x, y);
      }
    }
  }

  const pointCount = points.length / 2;
  const foregroundFraction = sampled > 0 ? pointCount / sampled : 0;

  // Too little foreground (or the object fills the whole frame, so there's no
  // background to separate against) to say anything reliable.
  if (pointCount < 40 || foregroundFraction > 0.97) {
    return { angleDeg: 0, confidence: 0, backgroundColor, foregroundFraction };
  }

  let cx = 0, cy = 0;
  for (let p = 0; p < points.length; p += 2) { cx += points[p]; cy += points[p + 1]; }
  cx /= pointCount; cy /= pointCount;

  // Coarse pass across the full range that matters for a rectangle (±45°),
  // then refine around the winner.
  const coarse = minAreaAngle(points, cx, cy, -45, 45, 1);
  const fine = minAreaAngle(points, cx, cy, coarse - 1.5, coarse + 1.5, 0.1);

  const confidence = Math.max(0, Math.min(1, foregroundFraction / 0.5));

  return { angleDeg: fine, confidence, backgroundColor, foregroundFraction };
}

export function loadImage(file: File): Promise<{ img: HTMLImageElement; objectUrl: string }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, objectUrl });
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = objectUrl;
  });
}

/** Downscaled canvas used for analysis — angle is scale-invariant, so this keeps detection fast. */
export function drawScaled(img: HTMLImageElement, maxDim = 500): HTMLCanvasElement {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  return canvas;
}

/** Rotates the full-resolution image by `angleDeg` (canvas convention: positive = clockwise), expanding the canvas so nothing is clipped. */
export function rotateToCanvas(img: HTMLImageElement, angleDeg: number, backgroundColor = '#000'): HTMLCanvasElement {
  const srcW = img.naturalWidth, srcH = img.naturalHeight;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const newW = Math.round(srcH * sin + srcW * cos);
  const newH = Math.round(srcH * cos + srcW * sin);

  const canvas = document.createElement('canvas');
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, newW, newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -srcW / 2, -srcH / 2);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), type, quality);
  });
}
