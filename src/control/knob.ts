// Rotary knob from the Immersive design: a dotted 270° track, the value as a brighter dotted arc, one dot as the pointer.
// Drag vertically (Shift = fine), wheel, arrow keys; double-click resets.
const SVG = 'http://www.w3.org/2000/svg';

function pt(v: number, r: number): [number, number] {
  const a = ((-135 + v * 270) * Math.PI) / 180;
  return [22 + r * Math.sin(a), 22 - r * Math.cos(a)];
}

function arc(v: number): string {
  const r = 18;
  const s = pt(0, r);
  const e = pt(Math.max(v, 0.001), r);
  return `M${s[0].toFixed(2)} ${s[1].toFixed(2)} A${r} ${r} 0 ${v * 270 > 180 ? 1 : 0} 1 ${e[0].toFixed(2)} ${e[1].toFixed(2)}`;
}

export interface Knob {
  el: HTMLElement;
  /** Shows a value without firing onInput (e.g. the knob position after a preset). */
  set(v: number): void;
  /** Effective value after modulation, drawn as a small dot on the outer ring. */
  setEffective(v: number): void;
}

export function knob(opts: {
  label: string;
  value: number;
  reset?: number;
  size?: number;
  live?: boolean;
  onInput: (v: number) => void;
}): Knob {
  let value = opts.value;
  const wrap = document.createElement('div');
  wrap.className = 'kn';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('role', 'slider');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-label', opts.label);
  svg.setAttribute('aria-valuemin', '0');
  svg.setAttribute('aria-valuemax', '1');
  if (opts.size) svg.style.width = svg.style.height = `${opts.size}px`;
  const track = document.createElementNS(SVG, 'path');
  track.setAttribute('class', 'kn-track');
  track.setAttribute('d', arc(1));
  const val = document.createElementNS(SVG, 'path');
  val.setAttribute('class', opts.live ? 'kn-val on' : 'kn-val');
  const eff = document.createElementNS(SVG, 'circle');
  eff.setAttribute('class', 'kn-eff');
  eff.setAttribute('r', '1.4');
  const face = document.createElementNS(SVG, 'circle');
  face.setAttribute('cx', '22');
  face.setAttribute('cy', '22');
  face.setAttribute('r', '10');
  face.setAttribute('fill', 'rgba(5,6,7,.7)');
  face.setAttribute('stroke', 'rgba(236,230,218,.22)');
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('r', '1.8');
  dot.setAttribute('fill', '#ece6da');
  svg.append(track, val, face, dot, eff);
  const name = document.createElement('span');
  name.className = 'lbl';
  name.textContent = opts.label;
  wrap.append(svg, name);

  const draw = () => {
    val.setAttribute('d', arc(value));
    const [x, y] = pt(value, 6.5);
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
    svg.setAttribute('aria-valuenow', value.toFixed(2));
  };
  const commit = (v: number) => {
    value = Math.min(1, Math.max(0, v));
    draw();
    opts.onInput(value);
  };

  let drag: { y: number; v: number } | null = null;
  svg.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, v: value };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    commit(drag.v + (drag.y - e.clientY) / (e.shiftKey ? 600 : 160));
  });
  const end = () => (drag = null);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    commit(value - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02));
  }, { passive: false });
  svg.addEventListener('dblclick', () => commit(opts.reset ?? opts.value));
  svg.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') commit(value + step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') commit(value - step);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  draw();

  return {
    el: wrap,
    set(v) {
      value = Math.min(1, Math.max(0, v));
      draw();
    },
    setEffective(v) {
      const [x, y] = pt(Math.min(1, Math.max(0, v)), 21.5);
      eff.setAttribute('cx', x.toFixed(2));
      eff.setAttribute('cy', y.toFixed(2));
    },
  };
}
