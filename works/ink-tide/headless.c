#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

enum { MAX_TEXTURES = 64, MAX_PROGRAMS = 16 };
static GLuint textures[MAX_TEXTURES], programs[MAX_PROGRAMS], framebuffer;
static int widths[MAX_TEXTURES], heights[MAX_TEXTURES];
static float time_now, mean_dye, area_dye, dye_x, dye_y, left_dye;
static float baseline, rebloom, burst_left;
static int checks;

static void fail(const char *message) {
  fprintf(stderr, "t=%.3f: %s\n", time_now, message);
  exit(1);
}

static GLuint compile(GLenum type, const char *source) {
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, NULL);
  glCompileShader(shader);
  GLint ok;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[8192];
    glGetShaderInfoLog(shader, sizeof(log), NULL, log);
    fprintf(stderr, "%s\n", log);
    fail("shader compilation");
  }
  return shader;
}

static GLuint program(const char *path, GLuint vertex) {
  FILE *file = fopen(path, "rb");
  if (!file) fail("shader file");
  fseek(file, 0, SEEK_END);
  long size = ftell(file);
  rewind(file);
  char *source = calloc(size + 1, 1);
  if (fread(source, 1, size, file) != (size_t)size) fail("shader read");
  fclose(file);
  GLuint fragment = compile(GL_FRAGMENT_SHADER, source);
  free(source);
  GLuint result = glCreateProgram();
  glAttachShader(result, vertex);
  glAttachShader(result, fragment);
  glLinkProgram(result);
  GLint ok;
  glGetProgramiv(result, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[8192];
    glGetProgramInfoLog(result, sizeof(log), NULL, log);
    fprintf(stderr, "%s: %s\n", path, log);
    fail("program link");
  }
  glDeleteShader(fragment);
  return result;
}

static float *read_texture(int id) {
  float *pixels = malloc(widths[id] * heights[id] * 4 * sizeof(float));
  glBindTexture(GL_TEXTURE_2D, textures[id]);
  glGetTexImage(GL_TEXTURE_2D, 0, GL_RGBA, GL_FLOAT, pixels);
  return pixels;
}

static void check(int kind, int id) {
  int w = widths[id], h = heights[id];
  float *pixels = read_texture(id);
  double mass = 0, area = 0, cx = 0, cy = 0, left = 0;
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    float *p = pixels + 4 * (y * w + x);
    for (int c = 0; c < 4; c++) if (!isfinite(p[c])) fail("non-finite texture");
    if (kind == 0) {
      if (hypotf(p[0], p[1]) > 1.803f) fail("velocity exceeds 1.8");
      if ((x == 0 || x == w - 1) && fabsf(p[0]) > 0.001f) fail("normal velocity at x wall");
      if ((y == 0 || y == h - 1) && fabsf(p[1]) > 0.001f) fail("normal velocity at y wall");
    } else if (kind == 1) {
      if (p[0] < 0 || p[0] > 3.003f) fail("density out of bounds");
      if ((x == 0 || y == 0 || x == w - 1 || y == h - 1) && p[0] > 0.001f) fail("dye stuck to a wall");
      float u = (x + 0.5f) / w, v = (y + 0.5f) / h;
      if (u + p[1] < -0.001f || u + p[1] > 1.001f || v + p[2] < -0.001f || v + p[2] > 1.001f)
        fail("material coordinate outside domain");
      mass += p[0]; cx += u * p[0]; cy += v * p[0];
      area += p[0] > 0.12f;
      if (u < 0.4f) left += p[0];
    } else {
      for (int c = 0; c < 3; c++) if (p[c] < 0 || p[c] > 100) fail("HDR output out of bounds");
    }
  }
  if (kind == 1) {
    mean_dye = mass / (w * h); area_dye = area / (w * h);
    dye_x = cx / fmax(mass, 1e-9); dye_y = cy / fmax(mass, 1e-9);
    left_dye = left / (w * h);
    if (time_now < 0.01f) baseline = mean_dye;
    if (time_now > 9.5f && time_now < 10 && (dye_x < 0.64f || dye_x > 0.8f || dye_y < 0.48f || dye_y > 0.72f))
      fail("build did not gather in view");
    if (time_now > 12 && time_now < 14) burst_left = fmaxf(burst_left, left_dye);
    if (time_now > 13.8f && time_now < 14) rebloom = fmaxf(rebloom, mean_dye);
    if (time_now >= 14 && (mean_dye < baseline * 0.3f || area_dye < 0.02f)) fail("empty frame after rebloom");
  }
  free(pixels);
  checks++;
}

static void snapshot(int id, int second, const char *directory) {
  char path[1024];
  snprintf(path, sizeof(path), "%s/%d.ppm", directory, second);
  FILE *file = fopen(path, "wb");
  if (!file) fail("snapshot file");
  int w = widths[id], h = heights[id];
  float *pixels = read_texture(id);
  fprintf(file, "P6\n%d %d\n255\n", w, h);
  for (int y = h - 1; y >= 0; y--) for (int x = 0; x < w; x++) for (int c = 0; c < 3; c++) {
    float value = pixels[4 * (y * w + x) + c];
    float aces = fminf(1, fmaxf(0, value * (2.51f * value + 0.03f) / (value * (2.43f * value + 0.59f) + 0.14f)));
    fputc((int)(255 * powf(aces, 1 / 2.2f)), file);
  }
  fclose(file); free(pixels);
  printf("%2ds density=%.4f coverage=%.3f centre=(%.3f,%.3f) left=%.4f\n", second, mean_dye, area_dye, dye_x, dye_y, left_dye);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  setvbuf(stdout, NULL, _IONBF, 0);
  CGLPixelFormatAttribute attributes[] = { kCGLPFAOpenGLProfile,
    (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core, kCGLPFAAllowOfflineRenderers, 0 };
  CGLPixelFormatObj format; CGLContextObj context; GLint count;
  if (CGLChoosePixelFormat(attributes, &format, &count) || !format) fail("CGL pixel format");
  if (CGLCreateContext(format, NULL, &context)) fail("CGL context");
  CGLDestroyPixelFormat(format); CGLSetCurrentContext(context);
  printf("Renderer: %s\n", glGetString(GL_RENDERER));
  GLuint vertex = compile(GL_VERTEX_SHADER, "#version 150\nout vec2 vUv;\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vUv=p;gl_Position=vec4(p*2.-1.,0.,1.);}");
  int program_count = atoi(argv[2]);
  if (program_count > MAX_PROGRAMS) fail("too many programs");
  char path[1024];
  for (int i = 0; i < program_count; i++) {
    snprintf(path, sizeof(path), "%s/%d.frag", argv[1], i);
    programs[i] = program(path, vertex);
  }
  glDeleteShader(vertex);
  glGenFramebuffers(1, &framebuffer);
  GLuint vao; glGenVertexArrays(1, &vao); glBindVertexArray(vao);
  snprintf(path, sizeof(path), "%s/commands", argv[1]);
  FILE *input = fopen(path, "r");
  if (!input) fail("command file");
  char command, name[128]; GLuint active = 0;
  while (fscanf(input, " %c", &command) == 1) {
    int id, a, b; float x, y;
    switch (command) {
      case 'N': fscanf(input, "%f", &time_now); break;
      case 'T':
        fscanf(input, "%d%d%d", &id, &a, &b);
        if (id >= MAX_TEXTURES) fail("too many textures");
        widths[id] = a; heights[id] = b;
        glGenTextures(1, &textures[id]); glBindTexture(GL_TEXTURE_2D, textures[id]);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, a, b, 0, GL_RGBA, GL_FLOAT, NULL);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        break;
      case 'P': fscanf(input, "%d", &id); active = programs[id]; glUseProgram(active); break;
      case 'F': fscanf(input, "%127s%f", name, &x); glUniform1f(glGetUniformLocation(active, name), x); break;
      case 'V': fscanf(input, "%127s%f%f", name, &x, &y); glUniform2f(glGetUniformLocation(active, name), x, y); break;
      case 'A': {
        float values[8]; fscanf(input, "%127s%d", name, &a);
        if (a > 8) fail("array length");
        for (int i = 0; i < a; i++) fscanf(input, "%f", &values[i]);
        glUniform1fv(glGetUniformLocation(active, name), a, values); break;
      }
      case 'S':
        fscanf(input, "%127s%d%d", name, &a, &id);
        glActiveTexture(GL_TEXTURE0 + a); glBindTexture(GL_TEXTURE_2D, textures[id]);
        glUniform1i(glGetUniformLocation(active, name), a); break;
      case 'D':
        fscanf(input, "%d", &id); glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[id], 0);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) fail("incomplete framebuffer");
        glViewport(0, 0, widths[id], heights[id]); glDrawArrays(GL_TRIANGLES, 0, 3); break;
      case 'B': fscanf(input, "%d%d", &a, &id); check(a, id); break;
      case 'O': fscanf(input, "%d%d", &id, &a); snapshot(id, a, argv[1]); break;
      default: fail("unknown command");
    }
    if ((command == 'D' || command == 'B') && glGetError() != GL_NO_ERROR) fail("OpenGL error");
  }
  fclose(input);
  if (burst_left < 0.0005f) fail("burst never crossed into calm left");
  if (rebloom < baseline * 0.3f) fail("did not rebloom within two seconds of burst");
  printf("%d readbacks; PASS: finite velocity/dye/material, clear walls, interior gather, left burst, rebloom\n", checks);
  glDeleteTextures(MAX_TEXTURES, textures); glDeleteFramebuffers(1, &framebuffer); glDeleteVertexArrays(1, &vao);
  for (int i = 0; i < program_count; i++) glDeleteProgram(programs[i]);
  CGLSetCurrentContext(NULL); CGLDestroyContext(context);
  return 0;
}
