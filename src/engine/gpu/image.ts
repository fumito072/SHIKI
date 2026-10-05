// Images in WebGPU worlds — the TSL counterpart of <shiki_image> in ../glsl.ts. Studio-built worlds start from their
// approved key visual and motion studies; load them with keyImage() and sample them with coverUv():
//   import kv from './keyvisual.jpg';
//   const key = keyImage(kv);                                  // texture + its pixel size as a uniform
//   material.colorNode = texture(key.tex, coverUv(uv(), vec2(16, 9), key.size));
import { Fn, select, uniform, vec2 } from 'three/tsl';
import type { Node, Texture, Vector2 } from 'three/webgpu';
import { imageSize, imageTexture } from '../assets';

/**
 * Maps 0..1 coordinates of a frame (a plane, the screen) so an image of pixel size `image` covers it without
 * stretching (centre crop), like CSS `object-fit: cover`. `frame` is the frame's size or aspect (e.g. vec2(16, 9)).
 */
export const coverUv = Fn(([p, frame, image]: [Node<'vec2'>, Node<'vec2'>, Node<'vec2'>]) => {
  const fa = frame.x.div(frame.y);
  const ia = image.x.div(image.y);
  const scale = select(fa.greaterThan(ia), vec2(1, ia.div(fa)), vec2(fa.div(ia), 1));
  return p.sub(0.5).mul(scale).add(0.5);
});

/** A colour-managed image texture plus a uniform holding its pixel size (16×9 until it has loaded). */
export function keyImage(url: string, opts: { repeat?: boolean } = {}) {
  const tex = imageTexture(url, opts) as unknown as Texture;
  // Shares the Vector2 imageTexture fills in when the pixels arrive, so the uniform updates itself.
  const size = uniform(imageSize(tex as never) as unknown as Vector2);
  return { tex, size };
}
