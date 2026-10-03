// SHIKI FX: kaleido
uniform sampler2D uTex;
uniform float uAmount;
uniform vec2 uResolution;
varying vec2 vUv;
void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 origin = vec2(0.43, 0.56);
  vec2 p = (vUv - origin) * vec2(aspect, 1.0);
  float segments = 3.0 + floor(uAmount * 9.0);
  float sector = 6.2831853 / segments;
  float angle = abs(mod(atan(p.y, p.x) + sector * 0.5, sector) - sector * 0.5);
  vec2 folded = origin + length(p) * vec2(cos(angle) / aspect, sin(angle));
  vec3 base = texture2D(uTex, vUv).rgb;
  vec3 reflected = texture2D(uTex, clamp(folded, 0.0, 1.0)).rgb;
  gl_FragColor = vec4(mix(base, reflected, uAmount), 1.0);
}
