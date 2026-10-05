# ALIEN SIGNAL — notes

## Feedback log

- 2026-10-05 · v1 preview (particle "jellyfish" creature): 「イメージ感としては悪くない」 but
  - 「パーティクルが安っぽい。このパーティクルのかっこいいを模索したい。今のパーティクルはダサい。」
  - 「エイリアンが今回のクラゲみたいなのはダサいな。」
  - 「発光もずっと発光ではなくて音によって発光させたりとかランダム性を求めたい。」
  - 「シンプルにさっきのyoutubeにいたメッシュエイリアンはかなりいけていたからそんなイメージでもう一度作ってほしい」
    (reference: "Alien Dance VJ Loop 4K" — neon wireframe humanoid aliens dancing in a group, motion locked to BPM)
  - Diagnosis of the cheap particles: identical round glowing sprites, additive stacking, heavy bloom (screensaver look).

## v2 direction

- A **mesh alien** of our own design (not a copy): concept image → Meshy image-to-3D → humanoid rig → library dances.
- Rendered as a **wireframe over a dark solid body** (the wires read as a 3D form, back wires hidden).
- **Light is an event, not a state**: the body stays dark; kicks, onsets and the drop light random patches / scan
  bands / single limbs, different every hit (seeded per hit). Never a constant glow.
- Dance **locked to the beat grid** (animation time driven by beats), a small crowd with offsets, the director cutting
  between close-ups (hands, skull), the group, low angles, orbits; the drop switches dance and look.
- Particles only as fine support (dust, sparks on hits) — no glowing blobs, light bloom only on events.
