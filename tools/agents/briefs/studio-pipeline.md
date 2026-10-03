# Task: Studio pipeline backend — image first, then motion studies, then the work

You are Codex in the SHIKI repo. Read `AGENTS.md`, `docs/philosophy.md`, `docs/taste.md`, `docs/agents.md` (section
"Studio から呼ぶエージェント") and the current `tools/agent-bridge/index.ts` first.

## Why

The user tried the Studio and the process is wrong: it jumps straight to code. The user's process (verbatim):

> いきなり動画を作成するのではなく、まずプロンプト、参考画像をもとに画像を作成 → FBを通じて最高のイメージの画像を作成 →
> そのあとその画像にどのような動きをつけるのか１０パターンぐらい画像化 → ここでもFB →
> 最終的に揃った題材をもとに動画化してVJ作品に昇華する。

They also want their Pinterest-trained image model in the loop to widen the range of expression.

## Files you own

- `tools/agent-bridge/pipeline/*.ts` (+ `*.test.ts`) — new
- `tools/agent-bridge/index.ts` — you may refactor it to share job/event/agent-spawn helpers with the pipeline. Keep every
  existing endpoint and behaviour (lean Claude flags, `ECC_HOOK_PROFILE=minimal`, env stripping, inlined docs, history
  snapshots, SSE replay, cancel, restore).
- `vite.config.ts` — only to add `'tools/**/*.test.ts'` to `test.include`.
- `.gitignore` — add `studio/`.
- `docs/studio-pipeline.md` — new, Japanese, short: the flow, storage, endpoints, engines.

Do not touch `src/**`, `works/**`, `design/**` (the orchestrator is rebuilding the UI against the API below in parallel).

## Storage

`studio/<id>/` at the repo root (gitignored). `<id>` is a slug (`^[a-z0-9][a-z0-9-]{0,40}$`), unique, derived from the
title, and becomes the work id at build time.

```
studio/<id>/project.json
studio/<id>/refs/NN.<ext>            user's reference images
studio/<id>/look/r<round>-<k>.png    key-visual candidates
studio/<id>/motion/r<round>-<k>.png  motion studies
```

```ts
type Stage = 'look' | 'motion' | 'build' | 'done';
type Engine = 'gpt-image' | 'pinterest-lora';
interface Item {
  id: string;                 // "look-r2-03"
  file: string | null;        // path relative to studio/<id>/, set when generated
  engine: Engine;
  prompt: string;
  title: string;              // short label (motion: Japanese name of the pattern)
  motion?: string;            // motion stage: 1–2 Japanese sentences — how it moves, which signal drives it
                              // (kick / tension / drop / beat) and which prediction-error device it uses
  status: 'queued' | 'running' | 'done' | 'error';
  error?: string;
  rating: -1 | 0 | 1;         // user: reject / none / like
  note: string;               // user's comment on this image
}
interface Round {
  n: number;
  stage: 'look' | 'motion';
  feedback: string;           // the user's FB that started the round ('' for the first)
  director: { agent: 'claude' | 'codex'; model: string; effort: string; notes: string }; // notes: the director's intent, Japanese
  items: Item[];
  at: number;
}
interface Project {
  id: string; title: string; brief: string;
  refs: string[];             // relative paths
  stage: Stage;
  rounds: Round[];
  keyVisual: string | null;   // chosen look item id
  studies: string[];          // chosen motion item ids (ordered)
  workId: string | null;      // set after a successful build
  created: number; updated: number;
}
```

## Endpoints (dev server, under `/__shiki/studio/`)

| | |
|---|---|
| `GET projects` | list `{id,title,stage,updated,cover}` (cover = key visual or newest image, relative URL) |
| `POST projects` `{title, brief, refs?: dataURL[]}` | create → Project |
| `GET project?id=` | Project |
| `POST project/update` `{id, title?, brief?}` | |
| `POST project/refs` `{id, refs: dataURL[]}` / `POST project/refs/remove` `{id, path}` | |
| `POST project/round` `{id, stage, feedback, count: {gpt: number, lora: number}, director: {agent, model, effort}, lora?: {weight?: number}}` | starts a round job → `{job}` |
| `POST project/rate` `{id, item, rating, note?}` | |
| `POST project/choose` `{id, keyVisual}` or `{id, studies: string[]}` | choosing a key visual moves stage to `motion` |
| `POST project/build` `{id, agent, model, effort}` | → `{job}` (see Build) |
| `GET file?id=&path=` | serves an image from `studio/<id>/` only (no traversal; correct content-type; cache headers) |
| `GET lora/status` | `{dir, installed, running, phase, loaded, message}` |
| `POST lora/start` | starts the LoRA server if installed and not running |

Round and build jobs use the existing job machinery: `GET /__shiki/agent/events?job=` (SSE, replay on reconnect),
`POST /__shiki/agent/cancel?job=` (kills every child process of the job), `GET /__shiki/agent/jobs`. Add an event type
`item` whose `text` is the JSON of the updated `Item` (emit on queued → running → done/error), so the UI can show images as
they arrive. One running round/build per project.

## A round

1. **Director** — run the selected agent read-only (Claude: `--tools Read` plus the existing lean flags; Codex:
   `-s read-only`) and capture its final text. It returns a fenced ```json block:
   `{"notes": "...", "items": [{"engine": "...", "title": "...", "prompt": "...", "motion"?: "..."}]}` with exactly
   `count.gpt` gpt-image items and `count.lora` pinterest-lora items (motion stage: gpt-image only, default 10).
   Parse robustly (last fenced json block, else first `{…}`), validate, and fail the job with a clear message if invalid.
   The director prompt inlines `docs/philosophy.md`, `docs/taste.md` and `docs/pinterest-aesthetic.md`, and includes:
   - the brief, the round history (titles, prompts, ratings, notes; liked first), and this round's feedback;
   - attached images: user refs, liked items of the stage (look), the chosen key visual (motion), and, if present,
     `$SHIKI_LORA_DIR/data_raw_contact.png` (the user's Pinterest saves contact sheet) as a taste reference;
   - look stage: make the candidates genuinely different from each other (composition, light, material, scale), keep
     what was liked, drop what was rejected, answer the feedback; landscape 16:9 for a VJ screen; no text in images;
   - pinterest-lora prompts describe only subject, composition, background and light — no style words (the LoRA adds
     the style: organic chrome filaments, proliferating structures); the trigger word is added by the server;
   - motion stage: 10 distinct motion patterns for the chosen key visual. Each image is one 16:9 frame that makes the
     motion readable as a still — a horizontal triptych of the same scene (calm → build → drop), or a long-exposure /
     multiple-exposure / smear depiction. Each must drive choreography from the audio (anticipation, tension → release,
     inertia, a broken expectation), never "vibrates with the music". `motion` explains it in Japanese.
2. **Images** — generate each item:
   - `gpt-image`: `codex exec` (lean, `-s workspace-write -C <repo>`, `model_reasoning_effort=low`) told to use its
     built-in image generation tool once, size 1536x1024, with the reference images attached via `-i` (look: refs + liked
     items; motion: the key visual first, as the scene to preserve), and to save the result at the absolute target path.
     If the file is missing after exit, take the newest file in `~/.codex/generated_images` created after the start.
     Up to 3 in parallel.
   - `pinterest-lora`: HTTP to `http://127.0.0.1:7860` (FastAPI in `$SHIKI_LORA_DIR`, default
     `~/development/fumito_proj_2026/stableDiffusion_LoRA`, see its `scripts/10_ui_server.py`): `POST /api/generate`
     `{prompt, weight (default .75), width: 1344, height: 768, count: 1}`, poll `GET /api/state` until it is idle with a
     new result, download `/gallery/<file>`. Serial (the server takes one job at a time; 409 = busy → wait and retry).
     If the server is not running, start it (`uv run --group eval --group ui scripts/10_ui_server.py`, detached, log to
     `.agents/lora.log`) and wait for `/api/state` phase != loading (it loads SDXL for about a minute; time out after
     5 minutes with a clear error). Do not read or print anything from its `.env`, `.tokens.json` or `.secrets`.
3. Save `project.json` after every item change.

## Build

`project/build`: requires a key visual and ≥ 1 study. Convert with `sips` to JPEG (max 1920 px, quality 85):
`works/<id>/keyvisual.jpg`, `works/<id>/studies/NN.jpg`, plus `works/<id>/studies.md` (title + motion + prompt for each).
Then start a create job through the existing run path with the work id forced to `<id>` (the done event's
`createdWorkId` must be `<id>` even though the folder already exists), the key visual and studies attached (Claude: paths
to Read; Codex: `-i`), and this added to the prompt: build the instrument from the key visual and the chosen studies —
a still frame must read like the key visual, the motion follows the studies mapped to kick / tension / drop; keep the
images in the folder. Set `project.stage = 'build'`; on success `stage = 'done'`, `workId = <id>`.

## Constraints

- Subscription CLIs only (keep the env stripping). No new npm dependencies (Node built-ins only).
- Validate every input (ids, stage, counts 1–12, data URLs ≤ 12 MB, ≤ 8 refs, path traversal).
- Unit tests: store CRUD/rate/choose, director JSON parsing and validation, path safety, gpt-image argument building,
  the LoRA client against a fake local HTTP server. `npx tsc --noEmit` and `npx vitest run` must pass.
- Do not spend money on real generations in tests. Do not start the dev server.

Final message (Japanese is fine): files, endpoints, how a round/build runs, what you could not verify, and anything the
UI must know.
