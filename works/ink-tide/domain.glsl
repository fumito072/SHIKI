vec2 inkAttractor(float aspect) { return vec2(aspect * 0.72, 0.6); }

vec2 inkSafeUv(vec2 uv, vec2 texel) {
  return clamp(uv, texel * 0.5, 1.0 - texel * 0.5);
}

// Zero at and outside the walls; never extend the edge texel's density.
float inkWall(vec2 uv, vec2 texel) {
  vec2 width = max(vec2(0.025), texel * 2.0);
  vec2 fade = smoothstep(texel * 0.5, width, uv)
    * smoothstep(texel * 0.5, width, 1.0 - uv);
  return fade.x * fade.y;
}
