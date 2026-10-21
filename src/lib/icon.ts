/** The toolbar icon, drawn in code so it can pulse red when there are too many tabs. */
const TAB_PATH = 'M20 90 H38 L46 52 C48 43 53 39 61 39 H67 C75 39 80 43 82 52 L90 90 H108';
const PAPER = '#ede8df';

export const INK = '#2a2520';
const RED_DEEP: [number, number, number] = [176, 32, 22];
const RED_BRIGHT: [number, number, number] = [255, 82, 64];

export function drawIcon(size: number, fill: string): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d')!;
  g.scale(size / 128, size / 128);
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(0, 0, 128, 128, 30);
  g.fill();
  g.strokeStyle = PAPER;
  g.lineWidth = size <= 16 ? 13 : 10;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke(new Path2D(TAB_PATH));
  return g.getImageData(0, 0, size, size);
}

export interface BeamFrame {
  icon: Record<number, ImageData>;
  badge: [number, number, number, number];
}

/** One breath from deep red to bright red and back. */
export function beamFrames(count = 14): BeamFrame[] {
  return Array.from({ length: count }, (_, i) => {
    const k = (1 - Math.cos((2 * Math.PI * i) / count)) / 2;
    const [r, g, b] = RED_DEEP.map((c, j) => Math.round(c + (RED_BRIGHT[j] - c) * k));
    const fill = `rgb(${r}, ${g}, ${b})`;
    return { icon: { 16: drawIcon(16, fill), 32: drawIcon(32, fill) }, badge: [r, g, b, 255] };
  });
}
