# Task: Meshy in the Studio — design image → 3D creature (GLB), optional rig + animation

You are Codex in the SHIKI repo. Read `AGENTS.md`, `docs/studio-pipeline.md`, `tools/agent-bridge/pipeline/*.ts`
(store, api, jobs, round, likes) first.

## Why

SHIKI works are becoming dynamic 3D worlds. The user has a Meshy subscription; its API turns a chosen design image into
a textured 3D model, and humanoid models can be auto-rigged and given motions (incl. dances) from Meshy's library.
Non-humanoid creatures are animated by our engine instead, so rigging is optional.

## Secrets

The key is `MESHY_API_KEY` in `<repo>/.env` (gitignored, written by the user). Read it from `process.env` or parse the
`.env` file yourself (simple `KEY=VALUE` lines). **Never print, log, emit, persist or return the key**, and never put it
in URLs or error messages. If it is missing, the endpoints say "Meshy の API キーが .env にありません".

## Meshy API (https://api.meshy.ai, header `Authorization: Bearer <key>`)

- Image to 3D: `POST /openapi/v1/image-to-3d` `{ image_url: <public URL or data URI (png/jpg)>, ai_model?, should_texture
  (default true), enable_pbr?, should_remesh?, topology?: 'triangle'|'quad', target_polycount? (100–300000),
  pose_mode?: ''|'a-pose'|'t-pose', target_formats?: ['glb'] }` → `{ result: taskId }`.
  `GET /openapi/v1/image-to-3d/:id` → `{ status: PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED, progress 0–100,
  model_urls: { glb, fbx, … }, thumbnail_url, task_error, consumed_credits, expires_at }`.
- Rigging (humanoid only; ≤ 300k faces; textured): `POST /openapi/v1/rigging` `{ input_task_id | model_url,
  height_meters? (1.7) }` → `{ result: id }`; `GET /openapi/v1/rigging/:id` → `result: { rigged_character_glb_url,
  basic_animations: { walking_glb_url, running_glb_url, … } }`, status/progress as above (≈5 credits).
- Animation: `POST /openapi/v1/animations` `{ rig_task_id, action_id | action_ids (1–10 unique) }` → id;
  `GET /openapi/v1/animations/:id` → `result: { animation_glb_url, … }` (3 credits per action).
  Library (free): `GET /openapi/v1/animations/library?category=Dancing|WalkAndRun|BodyMovements|DailyActions|Fighting&search=`
  → `[{ action_id, name, key, category, sub_category, preview_url }]`.
- Assets expire (≈3 days): download every file immediately. Treat signed URLs as secrets too (do not log them).
- Verify field names defensively (the responses may wrap results differently than above); fail with a clear message.

## Files you own

- `tools/agent-bridge/pipeline/meshy.ts` (+ `meshy.test.ts`), new routes in `tools/agent-bridge/pipeline/api.ts`,
  the `models` field in `tools/agent-bridge/pipeline/types.ts`/`store.ts`, `docs/studio-pipeline.md` (a short section).
- Do not touch `src/**`, `works/**`, `design/**`, `tools/agent-bridge/index.ts`.

## Endpoints (under `/__shiki/studio/`)

| | |
|---|---|
| `GET meshy/status` | `{ configured: boolean }` |
| `GET meshy/library?category=&search=` | proxies the animation library (cache 1 h) |
| `POST meshy/model` `{ id, item, rig?: boolean, actions?: number[], polycount?: number, pose?: ''|'a-pose'|'t-pose', pbr?: boolean }` | starts a job → `{ job }` |

The job (existing job/SSE machinery; one per project) sends the item's image (from `studio/<id>/`, as a PNG data URI),
polls every ~5 s emitting `status` events with progress, downloads the GLB (+ thumbnail) to
`studio/<id>/models/<item>.glb`; with `rig`, rigs it and downloads `…-rigged.glb`; with `actions`, animates and downloads
`…-anim.glb`. Record in `project.json`: `models: [{ id, item, file, thumb?, rigged?, anim?, actions?, tasks: { image,
rig?, anim? }, credits, createdAt }]` (files relative to the project). Serve them through the existing `file` route
(add `model/gltf-binary` for `.glb`). Cancel aborts polling and stops (Meshy tasks keep running remotely; say so).
Emit the total `consumed_credits` in the done summary.

## Tests

Fake `fetch` (no network): create→poll→download flow, rig + animation chaining, FAILED task, missing key, the key never
appears in emitted events/errors/project.json. `npx tsc --noEmit` and `npx vitest run tools` must pass. Do not call the
real API.

Final message (Japanese is fine): endpoints, what you could not verify against the live API, credits per call.
