# AIの役割分担（ハーネス）

最終更新：2026-10-03

SHIKI は Claude Code と Codex の2つのAIで作る。得意なことが違うので、仕事を分けて並行して進める。

## 役割

| 領域 | Claude Code | Codex |
|---|---|---|
| 全体設計・統合 | ◎ アーキテクチャ、エンジンの中核、作品の仕様（契約）、統合 | — |
| UI | ◎ デザインキャンバス → 実装、ブラウザでの見た目の確認 | — |
| 画像 | — | ◎ GPT Image（キービジュアル、テクスチャ、コンセプト画像） |
| 音の解析・アルゴリズム | 仕様を書いてレビュー | ◎ 仕様とテストが明確な単体モジュール（例：BeatTracker） |
| 作品（シェーダー） | ◎ 中核となる作品、品質の最終判断 | ◎ 仕様に沿った作品の並行制作・別案づくり |
| レビュー | ◎ 統合前の確認 | ◎ `codex review` によるセカンドオピニオン |
| 検証 | ◎ 実際に動かし、画面とfpsを確認 | 担当ファイルのテスト実行 |

同じ作品を両方に作らせて比べる、という使い方もできる（「AIが作り、人が選ぶ」をそのまま実行できる）。

## 進め方

1. **依頼書を書く**（Claude Code）：`tools/agents/briefs/<タスク名>.md` に、担当ファイル、インターフェース、合格条件を書く。
2. **Codex に渡す**：`tools/agents/codex-run.sh <タスク名> <依頼書> [推論の強さ]`
   - 実行記録は `.agents/runs/<日時>-<タスク名>/`（依頼書の写し、ログ、最終報告 `result.md`）。git には入れない。
3. **確認する**（Claude Code）：`git diff`、型チェック、テスト、ブラウザでの見た目。
4. **コミットする**（Claude Code）：確認が済んだものだけ。

Codex は担当ファイル以外を触らない。ほかに変更が必要なら、最終報告に書く。

## Codex MCP（shiki-codex）

`tools/codex-mcp/server.mjs` は、上のハーネスを MCP ツールとして Claude Code に公開する小さなサーバー。
このリポジトリで Claude Code を起動すると `.mcp.json` から読み込まれる（初回は承認が必要）。

| ツール | 内容 |
|---|---|
| `codex_start` | 依頼文を渡して Codex を裏で起動し、実行IDを返す |
| `codex_status` | 実行中か完了か、ログの末尾 |
| `codex_result` | 最終報告（`result.md`） |
| `codex_image` | GPT Image で画像を作り、指定したパスに保存する |

補足：インストール済みの Codex CLI（0.159.2）には `codex mcp-server` がないため、ユーザー全体の設定
（`~/.claude.json` の `codex`）は接続に失敗する。このプロジェクトでは `shiki-codex` を使う。

## Studio から呼ぶエージェント（agent bridge）

操作画面の Studio タブは `tools/agent-bridge/index.ts`（Vite の開発サーバーのプラグイン）を通して、
ユーザーのサブスクで動く CLI を起動する。API キーの環境変数（`ANTHROPIC_*`、`OPENAI_API_KEY`）は外して起動する。

| | Claude Code | Codex |
|---|---|---|
| 起動 | `claude -p … --model <ID> --effort <e> --output-format stream-json --permission-mode acceptEdits` | `codex exec -m <slug> -c model_reasoning_effort=<e> --json -s workspace-write [-i 画面]` |
| 使える道具 | Read / Edit / Write / Glob / Grep、`npx tsc`、`npm run typecheck`、`npx vitest`、`npm test`、`ls` | 作業フォルダ内の読み書きとコマンド |
| モデル | Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 4.5 | `codex debug models` の一覧（表示対象のもの） |

- Claude は軽量な起動にしている（`--strict-mcp-config`、`--disable-slash-commands`、`--setting-sources project,local`、
  ツールは Read / Edit / Write / Glob / Grep / Bash のみ、ECC プラグインのフックは `ECC_HOOK_PROFILE=minimal`）。
  同じ1行の編集で 33.8 秒 → 13.0 秒、費用も約 4 割。ユーザーが普段使う Claude Code の設定には影響しない
- 哲学（docs/philosophy.md）、好み（docs/taste.md）、作品メモ（NOTES.md）は指示文に直接埋め込む（読みに行く往復を省く）。
  AGENTS.md は両 CLI がプロジェクトの指示として自動で読む
- 1作品につき同時に1件。FB の前に `works/<id>/` を `.agents/history/<id>/<日時>/` に保存する（Versions の「戻す」で復元）
- 指示文は AGENTS.md、docs/philosophy.md、docs/taste.md、works/<id>/NOTES.md を先に読ませ、触ってよいのは対象の作品フォルダだけ
- 終わったら操作画面が作品を読み込み直して検証し、シェーダーのコンパイルエラーなどはそのまま修復依頼として送り返す（最大2回）
- 実行記録（添付画像など）は `.agents/studio/<job>/`。git には入れない
- エンドポイント：`GET /__shiki/agent/options`、`POST /__shiki/agent/run`、`GET /__shiki/agent/events?job=`（SSE）、
  `POST /__shiki/agent/cancel?job=`、`GET /__shiki/agent/jobs`、`GET /__shiki/history?work=`、`POST /__shiki/history/restore`
- 画像から作る制作工程（キービジュアル → 動きの画像 → 作品）の仕組みは [studio-pipeline.md](studio-pipeline.md)。
  アートディレクターは読み取り専用で起動し、絵は GPT Image（Codex 経由）と Pinterest LoRA（ローカルの SDXL）が描く
