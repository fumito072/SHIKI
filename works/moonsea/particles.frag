// MOONSEA — soft round droplet, additive, linear HDR.
varying float vBright;

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.05, length(p));
  vec3 col = mix(srgb(vec3(0.80, 0.83, 0.85)), srgb(vec3(0.70, 0.90, 0.94)), 0.35);
  gl_FragColor = vec4(col * vBright * a * 0.3, 1.0);
}
