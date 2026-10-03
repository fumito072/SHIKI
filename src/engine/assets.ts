// Image assets for works. Studio-built works start from their approved key visual and motion studies
// (works/<id>/keyvisual.jpg, works/<id>/studies/NN.jpg): import the file and turn it into a texture —
//   import kv from './keyvisual.jpg';
//   const tex = imageTexture(kv);           // uniform: { uKey: { value: tex } }, uKeySize: imageSize(tex)
// The texture is colour-managed (sRGB file → linear values in the shader, matching the HDR pipeline).
import { LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector2 } from 'three';
import type { Texture } from 'three';

const loader = new TextureLoader();

/** Returns immediately; the pixels arrive a moment later (the texture samples black until then). */
export function imageTexture(url: string, opts: { repeat?: boolean } = {}): Texture {
  const size = new Vector2(16, 9);
  const tex = loader.load(url, (t) => {
    const img = t.image as { width?: number; height?: number } | undefined;
    if (img?.width && img.height) size.set(img.width, img.height);
  });
  tex.colorSpace = SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  if (opts.repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.userData.size = size;
  return tex;
}

/** Pixel size of an imageTexture (16×9 until it has loaded); pass it as a uniform for cover-fitting (`coverUv`). */
export function imageSize(tex: Texture): Vector2 {
  return (tex.userData.size as Vector2 | undefined) ?? new Vector2(16, 9);
}
