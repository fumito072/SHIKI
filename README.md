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

- 操作ウィンドウ（Immersive：出ている映像を全面に敷き、操作はその上のガラスのパネル）
  - 左上・右上：デッキ A / B（プレビュー付き）。下：ライブラリ、トランジション、マクロ、FX、AI プロンプト、緊急ボタン
  - 作品一覧をクリック（または 1〜9）で、出ていない方のデッキ（キュー）に載せる。ダブルクリックで即カット
  - TAKE（T）：選んだ切り替え方・長さで、次の拍・小節・16/32 小節の頭から切り替える。X は即カット
  - 緊急：Black（esc）、Freeze（Z）、Safe（S：安全な作品に即切り替え。TAKE で戻る）
  - Master FX：Feedback / Kaleido / RGB split / Grain / Strobe（8Hz 上限）
  - テンポ（Space でタップ）、音の入力（Mic / Test track / File）、Build（B 長押し）と Drop（⏎）
- 「出力ウィンドウ」ボタンで映像だけの窓を開き、DELL のディスプレイへ移してダブルクリックで全画面。操作ウィンドウと同じ状態を映す
- `works/<作品>/` のコードやシェーダーを保存すると、止まらずにその場で差し替わる（失敗したら前の版のまま）

### Studio（画像から作る）

ヘッダーの **STUDIO**（または Tab）で切り替える。あなたのサブスクの Claude Code / Codex が動く（`claude` と `codex` にログイン済みであること）。
いきなりコードは作らない。**画像 → 動きの画像 → 作品** の順に、各段階で FB を挟む。

1. **Brief**：題名、作品ID（英数字・任意）、ブリーフ、参考画像（ドロップ / ペースト）を入れて「画像をつくる」
2. **Key visual**：アートディレクター（Claude / Codex、モデル・エフォートを選べる）が候補を設計し、
   **GPT Image** と **Pinterest LoRA**（あなたの Pinterest の保存画像で学習したモデル。必要なとき自動で起動）が描く。
   ♥ / ✕ / ひとこと を付け、言葉で FB して「次のラウンド」。気に入った1枚を「決定」→「次へ → 動き」
3. **Motion**：決めた画像に「どう動くか」を約10案、静止画で見せる（静 → 溜め → 解放の3コマなど）。
   ここでも ♥ / ✕ / FB でラウンドを重ねる
4. **Build**：♥ の動きで「作品にする」。キービジュアルと動きの画像を `works/<id>/` に置き、それを素材にして作品を作る。
   終わると自動でプレビューに読み込んで検証し、動かなければ同じエージェントに直させる（最大2回）
5. **Perform**：できた作品がデッキに入る

- **♥ Likes**：♥ を付けた画像は、制作をまたいで `library/likes/<制作>/` に画像とプロンプト・ひとこと付きで保存される
  （♥ を外すと消える。制作を消しても残る。git には入れない）。中央の「♥ Likes」で一覧、「参考に」で開いている制作の参考画像に、
  「Finder で開く」でフォルダへ。保存先は環境変数 `SHIKI_LIBRARY_DIR` で変えられる（例：iCloud Drive のフォルダ）
- 右の「作品を直す」タブでは、既存の作品のコードに直接 FB できる（今の画面の添付、FB 前の版への巻き戻し付き）
- Perform 画面下の **AI プロンプト** は、キュー側（出ていない方）のデッキの作品をその場で直す
- 全作品に共通する好みは [docs/taste.md](docs/taste.md)、Pinterest の傾向は [docs/pinterest-aesthetic.md](docs/pinterest-aesthetic.md)、
  作品ごとの経緯は `works/<作品>/NOTES.md`。制作中の画像は `studio/<id>/`（git には入れない）。仕組みは [docs/studio-pipeline.md](docs/studio-pipeline.md)

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | 型チェック |
| `npm test` | テスト |

## 技術の前提

- TypeScript ＋ Vite ＋ three.js ＋ GLSL（WebGL2）。まず Chrome で動かし、本番用に Electron で包む
- 作品は「楽器」：設定（つまみ・音の反応・プリセット・ムード）＋ 共通の入力値を受け取るシェーダー（仕様は [AGENTS.md](AGENTS.md)）
- 作業は Claude Code と Codex で分担する（[docs/agents.md](docs/agents.md)）
