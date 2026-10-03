# SHIKI

式・色・四季。VJ・リアルタイム映像クリエイターのための道具箱。
AIが映像の「楽器」を作り、人はフィードバックで育て、そのまま同じアプリで演奏（VJ）する。

- 非公開（クローズド）プロジェクト
- 現在の段階：**Step 0 完了（UI確定） → 次は Step 1：エンジンの中核**
- デザインキャンバス：<https://claude.ai/artifact/3QksTvWRciknftdPJcxuwi>（非公開。最上段の Immersive が確定版）

## フォルダ

| パス | 中身 |
|---|---|
| [docs/flow.md](docs/flow.md) | これからの流れ（Step 0〜5）と、毎回のやりとりの進め方 |
| [docs/decisions.md](docs/decisions.md) | 決まったこと／まだ決めていないこと |
| [docs/ui-spec.md](docs/ui-spec.md) | UI仕様（Immersive）：画面、色、書体、計器 |
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

- 操作ウィンドウ：作品の切り替え、つまみ、テンポ（Space でタップ）、音の入力（Mic / Test track / File）
- 「出力ウィンドウ」ボタンで映像だけの窓を開き、DELL のディスプレイへ移してダブルクリックで全画面
- `works/<作品>/` のコードやシェーダーを保存すると、止まらずにその場で差し替わる（失敗したら前の版のまま）

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | 型チェック |
| `npm test` | テスト |

## 技術の前提

- TypeScript ＋ Vite ＋ three.js ＋ GLSL（WebGL2）。まず Chrome で動かし、本番用に Electron で包む
- 作品は「楽器」：設定（つまみ・音の反応・プリセット・ムード）＋ 共通の入力値を受け取るシェーダー（仕様は [AGENTS.md](AGENTS.md)）
- 作業は Claude Code と Codex で分担する（[docs/agents.md](docs/agents.md)）
