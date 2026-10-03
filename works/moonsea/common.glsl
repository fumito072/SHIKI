// MOONSEA — shared by the background and the particles so both agree on the moon, the water and the omens.
uniform float uPClock;     // particle clock (seconds); stops while time is frozen on a drop
uniform float uMistClock;  // mist clock; slows to a halt as tension builds
uniform float uWaterClock; // wave clock
uniform float uTide;       // smoothed tension: the moon's pull
uniform float uFlood;      // how far the sea has climbed above the horizon (drop)
uniform float uBurst;      // release after the freeze, 0 → 1
uniform float uVis;        // particle visibility (fades out after the burst, grows back)

const float HORIZON = -0.30;
const float PI = 3.14159265;

// The moon drifts over a 32-beat phrase and leans toward the sea as the tide builds.
vec2 moonAt(float beats, float aspect) {
  float phrase = beats / 32.0 * 2.0 * PI;
  vec2 c = vec2(0.38 * aspect + 0.035 * sin(phrase * 0.5), 0.20 + 0.04 * sin(phrase));
  c.y -= 0.17 * uTide;
  return c;
}

// Water plane: world (x, depth) <-> screen.
vec2 worldToScreen(vec2 w) {
  return vec2(w.x / (w.y * 0.6), HORIZON - 1.0 / w.y);
}

// Where the ripple of beat n is born: in the moon's reflection column, at a seeded depth.
vec2 rippleSource(float n, vec2 moon) {
  float wz = 2.2 + 2.6 * hash11(n * 1.7 + 0.3);
  float wx = moon.x * 0.6 * wz + (hash11(n * 3.1 + 1.1) - 0.5) * 1.1;
  return vec2(wx, wz);
}
