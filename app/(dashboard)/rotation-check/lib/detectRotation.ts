// Client-side skew detection for card photos shot on a plain background.
// Mirrors the approach cv2.minAreaRect-based scripts use: threshold the card
// away from its background, take the largest solid blob, then search for the
// rotation angle that makes its bounding box smallest (i.e. squares it up).

export const ROTATION_THRESHOLD_DEG = 0.6;

export interface SkewDetection {
  angleDeg: number;
  confidence: number; // 0-1 — combines how much of the frame is foreground and how rectangular the blob is
  backgroundColor: string; // css rgb(), sampled from the border — reused when padding rotated output
  foregroundFraction: number;
}

interface RGB { r: number; g: number; b: number }

/** Average color/brightness along the full image border (more robust than just the 4 corners). */
function sampleBorder(data: Uint8ClampedArray, width: number, height: number): { rgb: RGB; brightness: number } {
  let r = 0, g = 0, b = 0, n = 0;
  const addPixel = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  };
  for (let x = 0; x < width; x++) { addPixel(x, 0); addPixel(x, height - 1); }
  for (let y = 0; y < height; y++) { addPixel(0, y); addPixel(width - 1, y); }
  const rgb = { r: r / n, g: g / n, b: b / n };
  const brightness = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
  return { rgb, brightness };
}

/** Otsu's method: finds the grayscale threshold that best splits the image into two classes. */
function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0, weightB = 0, maxVariance = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > maxVariance) { maxVariance = variance; threshold = t; }
  }
  return threshold;
}

interface BoxAtAngle { minX: number; maxX: number; minY: number; maxY: number; area: number }

function boundingBoxAtAngle(points: number[], cx: number, cy: number, angleDeg: number): BoxAtAngle {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let p = 0; p < points.length; p += 2) {
    const dx = points[p] - cx, dy = points[p + 1] - cy;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  return { minX, maxX, minY, maxY, area: (maxX - minX) * (maxY - minY) };
}

/** Angle (deg) that minimizes the axis-aligned bounding box of `points` when rotated about their centroid. */
function minAreaAngle(points: number[], cx: number, cy: number, from: number, to: number, stepDeg: number): number {
  let bestAngle = from;
  let bestArea = Infinity;
  for (let a = from; a <= to; a += stepDeg) {
    const { area } = boundingBoxAtAngle(points, cx, cy, a);
    if (area < bestArea) { bestArea = area; bestAngle = a; }
  }
  return bestAngle;
}

/**
 * Detects how far off-square an image is. Expects the photographed object to
 * sit on a roughly uniform background so it can be separated from it.
 *
 * Approach: Otsu-threshold the grayscale image into two classes, flood-fill
 * the "background-like" class in from the image border, and take whatever
 * that flood fill *doesn't* reach as the card. Flood-filling from the border
 * (rather than classifying every pixel independently) means dark regions
 * fully enclosed by the card — a cap, dark jersey, shadow — stay part of the
 * card blob instead of being mistaken for background, as long as the card's
 * own edge/border forms a closed boundary. The largest connected foreground
 * component is then used for the same minimize-the-bounding-box angle search
 * a cv2.minAreaRect-based approach would use.
 */
export function detectSkew(canvas: HTMLCanvasElement): SkewDetection {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const { data } = ctx.getImageData(0, 0, width, height);
  const totalPixels = width * height;

  const border = sampleBorder(data, width, height);
  const backgroundColor = `rgb(${Math.round(border.rgb.r)}, ${Math.round(border.rgb.g)}, ${Math.round(border.rgb.b)})`;

  const gray = new Uint8ClampedArray(totalPixels);
  for (let p = 0, i = 0; i < totalPixels; p += 4, i++) {
    gray[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  const otsuT = otsuThreshold(gray);
  const bgIsDark = border.brightness < otsuT;
  const isBackgroundLike = (v: number) => (bgIsDark ? v < otsuT : v >= otsuT);

  // Flood-fill background-like pixels inward from every border pixel.
  const reached = new Uint8Array(totalPixels); // 1 = classified as background
  const stack: number[] = [];
  const seed = (idx: number) => {
    if (!reached[idx] && isBackgroundLike(gray[idx])) { reached[idx] = 1; stack.push(idx); }
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % width, y = (idx / width) | 0;
    if (x > 0) seed(idx - 1);
    if (x < width - 1) seed(idx + 1);
    if (y > 0) seed(idx - width);
    if (y < height - 1) seed(idx + width);
  }

  // Label connected components among the remaining (foreground) pixels, keep the largest.
  const label = new Int32Array(totalPixels).fill(-1);
  let bestLabel = -1, bestSize = 0, curLabel = 0;
  const compStack: number[] = [];
  for (let start = 0; start < totalPixels; start++) {
    if (reached[start] || label[start] !== -1) continue;
    label[start] = curLabel;
    compStack.push(start);
    let size = 0;
    while (compStack.length) {
      const idx = compStack.pop()!;
      size++;
      const x = idx % width, y = (idx / width) | 0;
      if (x > 0 && !reached[idx - 1] && label[idx - 1] === -1) { label[idx - 1] = curLabel; compStack.push(idx - 1); }
      if (x < width - 1 && !reached[idx + 1] && label[idx + 1] === -1) { label[idx + 1] = curLabel; compStack.push(idx + 1); }
      if (y > 0 && !reached[idx - width] && label[idx - width] === -1) { label[idx - width] = curLabel; compStack.push(idx - width); }
      if (y < height - 1 && !reached[idx + width] && label[idx + width] === -1) { label[idx + width] = curLabel; compStack.push(idx + width); }
    }
    if (size > bestSize) { bestSize = size; bestLabel = curLabel; }
    curLabel++;
  }

  const foregroundFraction = bestSize / totalPixels;

  if (bestLabel === -1 || foregroundFraction < 0.02 || foregroundFraction > 0.97) {
    return { angleDeg: 0, confidence: 0, backgroundColor, foregroundFraction };
  }

  // Collect (and, if huge, subsample) the winning component's points — the
  // angle search only needs enough points to pin down the true extremes.
  const allPoints: number[] = [];
  for (let idx = 0; idx < totalPixels; idx++) {
    if (label[idx] === bestLabel) allPoints.push(idx % width, (idx / width) | 0);
  }
  const maxPoints = 6000;
  const compCount = allPoints.length / 2;
  const stride = Math.max(1, Math.floor(compCount / maxPoints));
  const points: number[] = [];
  for (let p = 0; p < allPoints.length; p += 2 * stride) points.push(allPoints[p], allPoints[p + 1]);

  let cx = 0, cy = 0;
  const pointCount = points.length / 2;
  for (let p = 0; p < points.length; p += 2) { cx += points[p]; cy += points[p + 1]; }
  cx /= pointCount; cy /= pointCount;

  // Coarse pass across the full range that matters for a rectangle (±45°),
  // then refine around the winner.
  const coarse = minAreaAngle(points, cx, cy, -45, 45, 1);
  const fine = minAreaAngle(points, cx, cy, coarse - 1.5, coarse + 1.5, 0.1);
  const { area } = boundingBoxAtAngle(points, cx, cy, fine);

  // How rectangular the blob is (real pixel count vs. its minimal bounding
  // box) — a clean card near 1.0, an irregular/false-positive shape lower.
  const rectangularity = area > 0 ? Math.max(0, Math.min(1, bestSize / area)) : 0;
  const confidence = Math.max(0, Math.min(1, foregroundFraction / 0.5))
    * Math.max(0, Math.min(1, (rectangularity - 0.5) / 0.4));

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
