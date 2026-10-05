import {
  HalfFloatType, LinearFilter, LinearSRGBColorSpace, NoBlending, NodeMaterial,
  QuadMesh, RenderTarget, RGBAFormat, Scene, Texture,
} from 'three/webgpu';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { dot, fract, positionLocal, texture, uv, vec3, vec4 } from 'three/tsl';

/** QuadMesh/TSL UVs are top-left; preserve the old GLSL math in bottom-left UVs. */
export const passUv = () => uv().flipY();
export const textureUniform = () => texture(new Texture());
export type TextureUniform = ReturnType<typeof textureUniform>;
// TextureNode handles the WebGL backend's render-target flip itself.
export const sample = (tex: TextureUniform, p: Node<'vec2'> = passUv()) => tex.sample(p.flipY());

export function hash12(p: Node<'vec2'>): Node<'float'> {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const b = a.add(dot(a, a.yzx.add(33.33)));
  return fract(b.x.add(b.y).mul(b.z));
}

/** Raw fragment output: no lighting, blending, depth writes or automatic display transform. */
export class FullscreenPass {
  readonly material = new NodeMaterial();
  private readonly quad: QuadMesh;
  private readonly scene = new Scene();

  constructor(fragmentNode: Node) {
    this.material.fragmentNode = fragmentNode;
    this.material.vertexNode = vec4(positionLocal.xy, 0, 1);
    this.material.toneMapped = false;
    this.material.depthTest = this.material.depthWrite = false;
    this.material.blending = NoBlending;
    this.quad = new QuadMesh(this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  render(renderer: WebGPURenderer, target: RenderTarget | null): void {
    renderer.setRenderTarget(target);
    // r186's fullscreenPass optimization clears the entire external canvas even with
    // autoClear=false. A Scene root preserves other multiview viewports on WebGPU.
    if (target === null) renderer.render(this.scene, this.quad.camera);
    else this.quad.render(renderer);
  }

  dispose(): void { this.material.dispose(); }
}

/** Only world/scratch/trial targets need depth; post-processing targets do not. */
export function createTarget(width: number, height: number, depthBuffer = false): RenderTarget {
  return new RenderTarget(Math.max(1, width), Math.max(1, height), {
    type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter,
    colorSpace: LinearSRGBColorSpace, depthBuffer,
  });
}

export class PingPong {
  read: RenderTarget;
  write: RenderTarget;
  constructor(width: number, height: number) {
    this.read = createTarget(width, height);
    this.write = createTarget(width, height);
  }
  swap(): void { [this.read, this.write] = [this.write, this.read]; }
  resize(width: number, height: number): void {
    this.read.setSize(Math.max(1, width), Math.max(1, height));
    this.write.setSize(Math.max(1, width), Math.max(1, height));
  }
  clear(renderer: WebGPURenderer): void {
    for (const target of [this.read, this.write]) {
      renderer.setRenderTarget(target);
      renderer.clear();
    }
  }
  dispose(): void { this.read.dispose(); this.write.dispose(); }
}

export class CopyPass {
  private readonly source = textureUniform();
  private readonly pass = new FullscreenPass(sample(this.source));
  render(renderer: WebGPURenderer, source: Texture, target: RenderTarget | null): void {
    this.source.value = source;
    this.pass.render(renderer, target);
  }
  dispose(): void { this.pass.dispose(); }
}
