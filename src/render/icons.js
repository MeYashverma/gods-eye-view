/**
 * Canvas-drawn marker glyphs.
 *
 * Aircraft and vessel markers need to point where the contact is heading.
 * Rather than ship a sprite sheet (which adds bytes and a licensing question),
 * the shapes are drawn once into an offscreen canvas at startup and rotated on
 * the GPU by the billboard. The atlas cache is keyed by shape and colour so a
 * layer that recolours by category does not redraw per marker.
 */

const cache = new Map();
const SIZE = 32;

/**
 * @param {'aircraft'|'vessel'|'satellite'|'camera'|'fire'} shape
 * @param {string} [color]
 */
export function createIconAtlas(shape, color = '#e8eef5') {
  const key = `${shape}:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  if (canvas) {
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.translate(SIZE / 2, SIZE / 2);
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(3,6,10,0.9)';
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      drawShape(ctx, shape);
      ctx.fill();
      ctx.stroke();
    }
  }

  const atlas = {
    shape,
    color,
    canvas,
    /** Billboards rotate on the GPU, so one glyph serves every heading. */
    imageFor() {
      return canvas;
    },
    dispose() {
      cache.delete(key);
    },
  };
  cache.set(key, atlas);
  return atlas;
}

function drawShape(ctx, shape) {
  ctx.beginPath();
  switch (shape) {
    case 'aircraft': {
      // Stylised airliner silhouette, nose up (north) at rotation 0.
      ctx.moveTo(0, -13);
      ctx.lineTo(2.2, -4);
      ctx.lineTo(12.5, 4.2);
      ctx.lineTo(12.5, 6.6);
      ctx.lineTo(2, 3.4);
      ctx.lineTo(1.6, 9.2);
      ctx.lineTo(5.6, 12.2);
      ctx.lineTo(5.6, 13.6);
      ctx.lineTo(0, 11.8);
      ctx.lineTo(-5.6, 13.6);
      ctx.lineTo(-5.6, 12.2);
      ctx.lineTo(-1.6, 9.2);
      ctx.lineTo(-2, 3.4);
      ctx.lineTo(-12.5, 6.6);
      ctx.lineTo(-12.5, 4.2);
      ctx.lineTo(-2.2, -4);
      ctx.closePath();
      break;
    }
    case 'vessel': {
      ctx.moveTo(0, -12);
      ctx.lineTo(4.6, -2);
      ctx.lineTo(4.6, 8);
      ctx.lineTo(0, 12);
      ctx.lineTo(-4.6, 8);
      ctx.lineTo(-4.6, -2);
      ctx.closePath();
      break;
    }
    case 'satellite': {
      ctx.rect(-2.4, -2.4, 4.8, 4.8);
      ctx.moveTo(-13, -2);
      ctx.rect(-13, -2, 8.4, 4);
      ctx.moveTo(4.6, -2);
      ctx.rect(4.6, -2, 8.4, 4);
      break;
    }
    case 'camera': {
      ctx.moveTo(0, -11);
      ctx.lineTo(9.5, 9);
      ctx.lineTo(0, 4.4);
      ctx.lineTo(-9.5, 9);
      ctx.closePath();
      break;
    }
    case 'fire': {
      ctx.moveTo(0, -12);
      ctx.bezierCurveTo(6, -5, 9, 1, 4.5, 7);
      ctx.bezierCurveTo(2.5, 11, -2.5, 11, -4.5, 7);
      ctx.bezierCurveTo(-9, 1, -6, -5, 0, -12);
      break;
    }
    case 'arrow': {
      // Wind barb: shaft plus a head, nose north at rotation 0.
      ctx.moveTo(0, -13);
      ctx.lineTo(4.4, -4.5);
      ctx.lineTo(1.5, -4.5);
      ctx.lineTo(1.5, 13);
      ctx.lineTo(-1.5, 13);
      ctx.lineTo(-1.5, -4.5);
      ctx.lineTo(-4.4, -4.5);
      ctx.closePath();
      break;
    }
    default: {
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
    }
  }
}

export function clearIconCache() {
  for (const atlas of cache.values()) atlas.dispose();
  cache.clear();
}
