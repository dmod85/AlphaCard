'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ROTATION_THRESHOLD_DEG,
  canvasToBlob,
  detectSkew,
  drawScaled,
  loadImage,
  rotateToCanvas,
} from './lib/detectRotation';

interface RotationItem {
  id: string;
  file: File;
  preview: string;
  status: 'analyzing' | 'done' | 'error';
  angleDeg?: number;
  confidence?: number;
  needsRotation?: boolean;
  correctedUrl?: string;
  error?: string;
}

export default function RotationCheckPage() {
  const [items, setItems] = useState<RotationItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analyzeFile = useCallback(async (id: string, file: File) => {
    let objectUrl: string | undefined;
    try {
      const loaded = await loadImage(file);
      objectUrl = loaded.objectUrl;
      const { img } = loaded;

      const analysisCanvas = drawScaled(img);
      const { angleDeg, confidence, backgroundColor } = detectSkew(analysisCanvas);
      const needsRotation = confidence > 0 && Math.abs(angleDeg) >= ROTATION_THRESHOLD_DEG;

      let correctedUrl: string | undefined;
      if (needsRotation) {
        const fullCanvas = rotateToCanvas(img, angleDeg, backgroundColor);
        const blob = await canvasToBlob(fullCanvas);
        correctedUrl = URL.createObjectURL(blob);
      }

      setItems(prev => prev.map(i => i.id === id
        ? { ...i, status: 'done', angleDeg, confidence, needsRotation, correctedUrl }
        : i));
    } catch (err: any) {
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, status: 'error', error: err.message || 'Failed to analyze' }
        : i));
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newItems: RotationItem[] = imageFiles.map(file => ({
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      status: 'analyzing' as const,
    }));

    setItems(prev => [...prev, ...newItems]);
    newItems.forEach(item => analyzeFile(item.id, item.file));
  }, [analyzeFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const removeItem = (id: string) => {
    setItems(prev => {
      const item = prev.find(i => i.id === id);
      if (item) {
        URL.revokeObjectURL(item.preview);
        if (item.correctedUrl) URL.revokeObjectURL(item.correctedUrl);
      }
      return prev.filter(i => i.id !== id);
    });
  };

  const clearAll = () => {
    items.forEach(i => {
      URL.revokeObjectURL(i.preview);
      if (i.correctedUrl) URL.revokeObjectURL(i.correctedUrl);
    });
    setItems([]);
  };

  const analyzing = items.filter(i => i.status === 'analyzing').length;
  const flagged = items.filter(i => i.status === 'done' && i.needsRotation);
  const straight = items.filter(i => i.status === 'done' && !i.needsRotation);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Rotation Check</h2>
          <p className="text-sm text-gray-500 mt-1">
            Drop in card photos to flag any that are crooked before you list them.
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={clearAll}
            className="px-4 py-2 bg-gray-800 text-gray-400 text-sm rounded-lg hover:bg-gray-700 transition"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Summary */}
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-gray-900 rounded-xl p-4">
            <div className="text-xs text-gray-500">Checked</div>
            <div className="text-lg font-semibold text-white">{items.length - analyzing}{analyzing > 0 ? ` (+${analyzing} analyzing…)` : ''}</div>
          </div>
          <div className="bg-gray-900 rounded-xl p-4">
            <div className="text-xs text-gray-500">Need rotation</div>
            <div className="text-lg font-semibold text-amber-400">{flagged.length}</div>
          </div>
          <div className="bg-gray-900 rounded-xl p-4">
            <div className="text-xs text-gray-500">Looks straight</div>
            <div className="text-lg font-semibold text-green-400">{straight.length}</div>
          </div>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition ${
          dragOver
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 hover:border-gray-500 hover:bg-gray-900/50'
        }`}
      >
        <div className="text-2xl text-gray-500 mb-1">+</div>
        <p className="text-sm text-gray-400">Drag &amp; drop photos here, or click to select</p>
        <p className="text-xs text-gray-600 mt-1">Works best against a plain, consistent background</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Results grid */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mt-6">
          {items.map(item => (
            <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="relative aspect-[3/4] bg-gray-950">
                <img src={item.correctedUrl ?? item.preview} alt="" className="w-full h-full object-contain" />

                {item.status === 'analyzing' && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                )}

                <button
                  onClick={() => removeItem(item.id)}
                  className="absolute top-1.5 right-1.5 w-5 h-5 bg-black/70 rounded-full text-white text-xs flex items-center justify-center hover:bg-red-500 transition"
                >
                  ✕
                </button>

                {item.status === 'done' && (
                  <span className={`absolute bottom-1.5 left-1.5 text-[10px] px-2 py-0.5 rounded-full ${
                    item.needsRotation
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-green-500/20 text-green-400'
                  }`}>
                    {item.needsRotation
                      ? `${item.angleDeg! > 0 ? '↻' : '↺'} ${Math.abs(item.angleDeg!).toFixed(1)}°`
                      : '✓ Straight'}
                  </span>
                )}
              </div>

              <div className="p-2.5">
                <p className="text-xs text-gray-400 truncate" title={item.file.name}>{item.file.name}</p>

                {item.status === 'error' && (
                  <p className="text-[10px] text-red-400 mt-1">{item.error}</p>
                )}

                {item.status === 'done' && item.needsRotation && item.correctedUrl && (
                  <a
                    href={item.correctedUrl}
                    download={`straightened-${item.file.name}`}
                    className="mt-2 block text-center text-[10px] px-2 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition"
                  >
                    Download corrected
                  </a>
                )}

                {item.status === 'done' && !item.needsRotation && item.confidence !== undefined && item.confidence < 0.15 && (
                  <p className="text-[10px] text-gray-600 mt-1.5">
                    Low confidence — background may not be uniform enough to check.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
