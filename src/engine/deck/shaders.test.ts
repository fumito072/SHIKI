import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ShaderChunk } from 'three';
import '../glsl';

// Native CGL checks real shader output without a browser or another dependency.
const runner = String.raw`
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

static GLuint shader(GLenum type, const char *source) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &source, NULL); glCompileShader(s);
  GLint ok; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[8192]; glGetShaderInfoLog(s, sizeof(log), NULL, log); fprintf(stderr, "%s\n", log); exit(2); }
  return s;
}
static char *read_source(const char *path) {
  FILE *f = fopen(path, "rb"); if (!f) exit(3);
  fseek(f, 0, SEEK_END); long n = ftell(f); rewind(f);
  char *s = calloc(n + 1, 1); fread(s, 1, n, f); fclose(f); return s;
}
static GLuint texture(float r, float g, float b) {
  float pixels[16]; for (int i = 0; i < 4; i++) {
    pixels[i * 4] = r; pixels[i * 4 + 1] = g; pixels[i * 4 + 2] = b; pixels[i * 4 + 3] = 1;
  }
  GLuint t; glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 2, 2, 0, GL_RGBA, GL_FLOAT, pixels);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  return t;
}
static void scalar(GLuint p, const char *name, float v) { glUniform1f(glGetUniformLocation(p, name), v); }
static void sampler(GLuint p, const char *name, GLuint tex, int unit) {
  glActiveTexture(GL_TEXTURE0 + unit); glBindTexture(GL_TEXTURE_2D, tex);
  glUniform1i(glGetUniformLocation(p, name), unit);
}
int main(int argc, char **argv) {
  CGLPixelFormatAttribute attrs[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
    kCGLPFAAllowOfflineRenderers, (CGLPixelFormatAttribute)0 };
  CGLPixelFormatObj format; GLint count; CGLContextObj context;
  if (CGLChoosePixelFormat(attrs, &format, &count) != kCGLNoError || !format ||
      CGLCreateContext(format, NULL, &context) != kCGLNoError) { fprintf(stderr, "CGL unavailable\n"); return 4; }
  CGLDestroyPixelFormat(format); CGLSetCurrentContext(context);
  GLuint vao; glGenVertexArrays(1, &vao); glBindVertexArray(vao);
  GLuint vert = shader(GL_VERTEX_SHADER,
    "#version 150\nout vec2 vUv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.0-1.0,0,1); }");
  GLuint from = texture(0.2, 0.4, 0.8), incoming = texture(0.8, 0.1, 0.3), history = texture(0.9, 0.5, 0.1);
  GLuint output = texture(0, 0, 0), fb;
  glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, output, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) return 5;
  glViewport(0, 0, 2, 2);
  for (int i = 1; i < argc; i++) {
    char *source = read_source(argv[i]); GLuint frag = shader(GL_FRAGMENT_SHADER, source); free(source);
    GLuint p = glCreateProgram(); glAttachShader(p, vert); glAttachShader(p, frag); glLinkProgram(p);
    GLint ok; glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) { char log[8192]; glGetProgramInfoLog(p, sizeof(log), NULL, log); fprintf(stderr, "%s\n", log); return 6; }
    glUseProgram(p);
    sampler(p, "uFrom", from, 0); sampler(p, "uTo", incoming, 1);
    sampler(p, "uHistory", history, 2); sampler(p, "uTex", from, 0);
    glUniform2f(glGetUniformLocation(p, "uResolution"), 2, 2);
    scalar(p, "uTime", 1.25); scalar(p, "uDt", 0.016); scalar(p, "uDecay", 0.9);
    scalar(p, "uBeat", 0.1); scalar(p, "uGate", 1); scalar(p, "uExposure", 1);
    scalar(p, "uVignette", 0.35); scalar(p, "uGrain", 0.035);
    // The first five programs are transitions. Check exact linear-HDR endpoints.
    for (int step = 0; step < 3; step++) {
      float progress = step * 0.5;
      scalar(p, "uProgress", progress); scalar(p, "uAmount", progress);
      glDrawArrays(GL_TRIANGLES, 0, 3);
      float pixels[16]; glReadPixels(0, 0, 2, 2, GL_RGBA, GL_FLOAT, pixels);
      if (glGetError() != GL_NO_ERROR) { fprintf(stderr, "GL error in %s\n", argv[i]); return 7; }
      for (int pixel = 0; pixel < 4; pixel++) for (int channel = 0; channel < 4; channel++) {
        float value = pixels[pixel * 4 + channel];
        if (!isfinite(value) || value < -0.0001 || value > 2) return 8;
        if (i <= 5 && (step == 0 || step == 2)) {
          float a[] = { 0.2, 0.4, 0.8, 1 }, b[] = { 0.8, 0.1, 0.3, 1 };
          float expected = step == 0 ? a[channel] : b[channel];
          if (fabsf(value - expected) > 0.0001) {
            fprintf(stderr, "Bad endpoint %s: %.6f expected %.6f\n", argv[i], value, expected); return 9;
          }
        }
      }
    }
    glDeleteProgram(p); glDeleteShader(frag);
  }
  glDeleteShader(vert); glDeleteFramebuffers(1, &fb); glDeleteVertexArrays(1, &vao);
  GLuint textures[] = {from, incoming, history, output}; glDeleteTextures(4, textures);
  CGLSetCurrentContext(NULL); CGLDestroyContext(context);
  puts("PASS: all shaders compile, finite HDR output, exact transition endpoints");
  return 0;
}
`;

it.runIf(process.platform === 'darwin')('compiles every transition/FX/finish shader and renders finite HDR endpoints on CGL', context => {
  const dir = mkdtempSync(join(tmpdir(), 'shiki-deck-shaders-'));
  try {
    const sources = [
      'transitions/cut.frag', 'transitions/dissolve.frag', 'transitions/luma-wipe.frag',
      'transitions/displace.frag', 'transitions/feedback-melt.frag',
      'fx/feedback.frag', 'fx/kaleido.frag', 'fx/rgb-split.frag', 'fx/grain.frag', 'fx/strobe.frag', 'finish.frag',
    ];
    const chunks = ShaderChunk as unknown as Record<string, string>;
    const paths = sources.map((name, i) => {
      const original = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
      const expanded = original.replace(/#include <(\w+)>/g, (_, key: string) => chunks[key]);
      const path = join(dir, `${i}.frag`);
      writeFileSync(path, '#version 150\n#define texture2D texture\nout vec4 fragColor;\n'
        + expanded.replace(/varying /g, 'in ').replace(/gl_FragColor/g, 'fragColor'));
      return path;
    });
    const c = join(dir, 'check.c'), executable = join(dir, 'check');
    writeFileSync(c, runner);
    execFileSync('/usr/bin/clang', ['-Wno-deprecated-declarations', '-O2', '-framework', 'OpenGL', c, '-o', executable], { timeout: 30_000 });
    const result = spawnSync(executable, paths, { encoding: 'utf8', timeout: 30_000 });
    if (result.status === 4) context.skip('CGL GPU context is unavailable in this environment');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS: all shaders compile, finite HDR output, exact transition endpoints');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
