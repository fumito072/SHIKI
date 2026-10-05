import { describe, expect, it, vi } from 'vitest';
import {
  LinearSRGBColorSpace, Mesh, NoToneMapping, OrthographicCamera, PlaneGeometry,
  Scene, WebGPURenderer,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { vec4 } from 'three/tsl';
import WGSLNodeBuilder from 'three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js';
import GLSLNodeBuilder from 'three/src/renderers/webgl-fallback/nodes/GLSLNodeBuilder.js';
import type { Transition } from '../deck/scheduling';
import type { MasterFx } from './DeckEngine';
import { transitionNode, transitionUniforms } from './transitions';
import { fxNode, fxUniforms } from './fx';
import { finishNode, finishUniforms } from './finish';
import { CopyPass, FullscreenPass, PingPong, createTarget, sample, textureUniform } from './passes';

// Exercise real TSL lowering without initializing either backend or requesting a GPU.
function build(fragment: Node, webgl: boolean): string {
  const renderer = new WebGPURenderer({ canvas: { width: 64, height: 36 } as HTMLCanvasElement, forceWebGL: webgl });
  renderer.hasFeature = () => false;
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  const pass = new FullscreenPass(fragment);
  pass.material.vertexNode = vec4(0, 0, 0, 1);
  const geometry = new PlaneGeometry(2, 2);
  const mesh = new Mesh(geometry, pass.material);
  const Builder = webgl ? GLSLNodeBuilder : WGSLNodeBuilder;
  // These internal builder fields are omitted from @types/three 0.186.
  const builder = new Builder(mesh, renderer) as InstanceType<typeof Builder> & {
    camera: OrthographicCamera; scene: Scene; build(): void; fragmentShader: string;
  };
  builder.camera = new OrthographicCamera();
  builder.scene = new Scene();
  try {
    builder.build();
    return builder.fragmentShader!;
  } finally {
    pass.dispose();
    geometry.dispose();
    // No backend was initialized; dispose() itself would initiate one in r186.
  }
}

describe.each([false, true])('TSL lowering (WebGL fallback: %s)', webgl => {
  it.each<Transition>(['cut', 'dissolve', 'luma-wipe', 'displace', 'feedback-melt'])('builds %s', kind => {
    const u = transitionUniforms(), targets = [createTarget(64, 36), createTarget(64, 36), createTarget(64, 36)];
    [u.uFrom.value, u.uTo.value, u.uHistory.value] = targets.map(t => t.texture);
    const shader = build(transitionNode(kind, u), webgl);
    expect(shader).toContain(webgl ? 'texture(' : 'textureSample(');
    expect(shader).not.toMatch(/undefined|NaN|Infinity/);
    targets.forEach(t => t.dispose());
  });

  it.each<MasterFx>(['feedback', 'kaleido', 'rgb-split', 'grain', 'strobe'])('builds %s', kind => {
    const u = fxUniforms(), target = createTarget(64, 36);
    u.uTex.value = u.uHistory.value = target.texture;
    const shader = build(fxNode(kind, u), webgl);
    expect(shader).toContain(webgl ? 'texture(' : 'textureSample(');
    expect(shader).not.toMatch(/undefined|NaN|Infinity/);
    if (kind === 'kaleido') expect(shader).toContain(webgl ? 'atan(' : 'atan2(');
    target.dispose();
  });

  it('builds finishing with one explicit ACES/gamma transform and no automatic sRGB transform', () => {
    const u = finishUniforms(), target = createTarget(64, 36);
    u.uTex.value = target.texture;
    const shader = build(finishNode(u), webgl);
    expect(shader).toContain('2.51');
    expect(shader).toContain('pow(');
    expect(shader).not.toMatch(/sRGBTransferOETF|LinearToSRGB|NaN|undefined/);
    target.dispose();
  });

  it('builds texture copy', () => {
    const tex = textureUniform(), target = createTarget(64, 36);
    tex.value = target.texture;
    expect(build(sample(tex), webgl)).toContain(webgl ? 'texture(' : 'textureSample(');
    target.dispose();
  });
});

it('updates all samples through their base texture node when swapping feedback targets', () => {
  const history = new PingPong(8, 4), tex = textureUniform();
  tex.value = history.read.texture;
  const sampled = sample(tex);
  expect(sampled.value).toBe(history.read.texture);
  history.swap();
  tex.value = history.read.texture;
  expect(sampled.value).toBe(history.read.texture);
  history.dispose();
});

it('renders full-screen passes through QuadMesh with no blending/depth/tone mapping', () => {
  const renderer = { setRenderTarget: vi.fn(), render: vi.fn() } as unknown as WebGPURenderer;
  const pass = new FullscreenPass(vec4(1, 0, 0, 1));
  pass.render(renderer, null);
  const scene = vi.mocked(renderer.render).mock.calls[0][0];
  expect(scene).toHaveProperty('isScene', true);
  expect(scene).not.toHaveProperty('isQuadMesh');
  const mesh = scene.children[0];
  expect(mesh).toHaveProperty('isQuadMesh', true);
  expect(pass.material).toMatchObject({ depthTest: false, depthWrite: false, toneMapped: false });
  expect(renderer.setRenderTarget).toHaveBeenCalledWith(null);
  const dispose = vi.spyOn(pass.material, 'dispose');
  pass.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  const copy = new CopyPass(), target = createTarget(1, 1);
  copy.render(renderer, target.texture, null);
  expect(renderer.render).toHaveBeenCalledTimes(2);
  copy.dispose(); target.dispose();
});
