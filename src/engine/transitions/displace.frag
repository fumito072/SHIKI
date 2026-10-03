// SHIKI transition: displace
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform vec2 uResolution;
varying vec2 vUv;
float lightAt(vec2 uv) {
  vec3 c = max(texture2D(uTo, clamp(uv, 0.0, 1.0)).rgb, 0.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return l / (1.0 + l);
}
void main() {
  vec2 e = 3.0 / uResolution;
  vec2 gradient = vec2(lightAt(vUv + vec2(e.x, 0.0)) - lightAt(vUv - vec2(e.x, 0.0)),
                       lightAt(vUv + vec2(0.0, e.y)) - lightAt(vUv - vec2(0.0, e.y)));
  float envelope = sin(uProgress * 3.14159265);
  vec2 uv = clamp(vUv - gradient * envelope * 0.24, 0.0, 1.0);
  gl_FragColor = mix(texture2D(uFrom, uv), texture2D(uTo, vUv), uProgress);
}
