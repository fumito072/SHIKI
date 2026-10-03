# SHIKI

式・色・四季。VJ・リアルタイム映像クリエイターのための道具箱。
AIが映像の「楽器」を作り、人はフィードバックで育て、そのまま同じアプリで演奏（VJ）する。

- 非公開（クローズド）プロジェクト
- 現在の段階：**Step 1 完了 → Step 2（Perform）進行中。Studio（AI による制作と FB）も使える**
- デザインキャンバス：<https://claude.ai/artifact/3QksTvWRciknftdPJcxuwi>（非公開。最上段の Immersive が確定版）

## フォルダ

| パス | 中身 |
|---|---|
| [docs/flow.md](docs/flow.md) | これからの流れ（Step 0〜5）と、毎回のやりとりの進め方 |
| [docs/decisions.md](docs/decisions.md) | 決まったこと／まだ決めていないこと |
| [docs/ui-spec.md](docs/ui-spec.md) | UI仕様（Immersive）：画面、色、書体、計器 |
| [docs/taste.md](docs/taste.md) | あなたの好み（全作品共通）。AI が FB から書き足す |
| `tools/agent-bridge/` | Studio の裏側：開発サーバーから Claude Code / Codex を起動する |
| `design/tokens/` | 書体・色・計器のCSS。実装の出発点 |
| `design/canvas/` | デザインキャンバスの元データ（参照用。キャンバスのランタイムが前提なので単体では動かない） |
| `design/key-visuals/` | 作品のキービジュアル（GPT Image で生成） |
| `design/concepts/` | UIのコンセプト画像（GPT Image で生成） |

## 動かし方

```bash
npm install
npm run gen:testtrack   # テスト音源（128 BPM）を作る
npm run dev             # http://localhost:5173 を Chrome で開く
```

- 操作ウィンドウ
  - 上：PGM（いま出ている映像）。下：デッキ A / B のプレビューと TAKE 列
  - 作品一覧をクリック（または 1〜9）で、出ていない方のデッキ（キュー）に載せる。ダブルクリックで即カット
  - TAKE（T）：選んだ切り替え方・長さで、次の拍・小節・16/32 小節の頭から切り替える。X は即カット
  - 緊急：Black（esc）、Freeze（Z）、Safe（S：安全な作品に即切り替え。TAKE で戻る）
  - Master FX：Feedback / Kaleido / RGB split / Grain / Strobe（8Hz 上限）
  - テンポ（Space でタップ）、音の入力（Mic / Test track / File）、Build（B 長押し）と Drop（⏎）
- 「出力ウィンドウ」ボタンで映像だけの窓を開き、DELL のディスプレイへ移してダブルクリックで全画面。操作ウィンドウと同じ状態を映す
- `works/<作品>/` のコードやシェーダーを保存すると、止まらずにその場で差し替わる（失敗したら前の版のまま）

### Studio（AI に作らせる・FB する）

右側の **Studio** タブから、あなたのサブスクの Claude Code / Codex に作業させる（`claude` と `codex` にログイン済みであること）。

- **この作品に FB**：選択中のデッキ（枠が水色）の作品に、感じたことをそのまま書いて送る。下のチップで定番の指摘を足せる
- **新しい作品**：どんな作品かを書いて送る。Codex なら「キービジュアル（画像）から始める」も選べる
- エージェント（Claude / Codex）、モデル、エフォートを選べる。選択は次回も残る
- 「今の画面を添付」で PGM の画面をエージェントに見せる
- 終わると自動でプレビューに読み込んで検証し、動かなければ同じエージェントに自動で直させる（最大2回）
- **Versions**：FB を送る直前の状態が残る。「戻す」を2回押すと、その版に戻る（戻す前の状態も残る）
- 全作品に共通する好みは [docs/taste.md](docs/taste.md)、作品ごとの経緯は `works/<作品>/NOTES.md` に AI が書き足す

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | 型チェック |
| `npm test` | テスト |

## 技術の前提

- TypeScript ＋ Vite ＋ three.js ＋ GLSL（WebGL2）。まず Chrome で動かし、本番用に Electron で包む
- 作品は「楽器」：設定（つまみ・音の反応・プリセット・ムード）＋ 共通の入力値を受け取るシェーダー（仕様は [AGENTS.md](AGENTS.md)）
- 作業は Claude Code と Codex で分担する（[docs/agents.md](docs/agents.md)）
