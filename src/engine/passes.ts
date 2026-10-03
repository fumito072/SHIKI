import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
} from 'three';
import type { Blending, IUniform, Texture, WebGLRenderer } from 'three';
import { FULLSCREEN_VERT } from './glsl';

const quad = new PlaneGeometry(2, 2);
const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** A fragment shader drawn over the whole target. */
export class FullscreenPass {
  readonly material: ShaderMaterial;
  private readonly scene = new Scene();

  constructor(opts: { fragmentShader: string; uniforms: Record<string, IUniform>; blending?: Blending }) {
    this.material = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: opts.fragmentShader,
      uniforms: opts.uniforms,
      blending: opts.blending ?? NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(quad, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}

export function createTarget(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
}

/** Two targets for feedback: read last frame from `read`, draw into `write`, then `swap()`. */
export class PingPong {
  read: WebGLRenderTarget;
  write: WebGLRenderTarget;

  constructor(width: number, height: number) {
    this.read = createTarget(width, height);
    this.write = createTarget(width, height);
  }

  swap(): void {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  resize(width: number, height: number): void {
    this.read.setSize(Math.max(1, width), Math.max(1, height));
    this.write.setSize(Math.max(1, width), Math.max(1, height));
  }

  clear(renderer: WebGLRenderer): void {
    for (const t of [this.read, this.write]) {
      renderer.setRenderTarget(t);
      renderer.clear();
    }
  }

  dispose(): void {
    this.read.dispose();
    this.write.dispose();
  }
}

/** Copies a texture into a target unchanged. */
export class CopyPass {
  private readonly uniforms = { uTex: { value: null as Texture | null } };
  private readonly pass = new FullscreenPass({
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(uTex, vUv); }
    `,
    uniforms: this.uniforms,
  });

  render(renderer: WebGLRenderer, source: Texture, target: WebGLRenderTarget | null): void {
    this.uniforms.uTex.value = source;
    this.pass.render(renderer, target);
  }

  dispose(): void {
    this.pass.dispose();
  }
}
