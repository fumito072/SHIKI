# Studio の制作パイプライン

画像を選ぶまでコードは作らない。`look`（画像候補 → 評価・コメント → 次の候補）から、
キービジュアルを決めて `motion`（動きの静止画案 → FB → 選定）、最後に `build` → `done` と進む。
動きの案は標準10枚。同じ場面の「静 → 溜め → DROP」の三連画や多重露光で振り付けを示す。
音は振動ではなく、先回り、慣性、時間の逆行などの予測誤差を動かす。

## 保存

gitignore の `studio/<id>/` に `project.json`、`refs/NN.<ext>`、
`look/r<round>-<k>.png`、`motion/r<round>-<k>.png` を保存する。id はタイトルから作る一意のスラッグで、
作品 id にもなる。日本語だけのタイトルはハッシュを使う。画像の状態変更ごとに JSON を原子的に保存。
ビルド時は `sips` で最大1920px・品質85の JPEG を `works/<id>/keyvisual.jpg` と
`studies/NN.jpg` に変換し、選んだ順に説明を `studies.md` に残す。再ビルド前は既存の履歴へ保存する。
ジョブとSSEの履歴は開発サーバーのメモリ内のみ。再起動後もプロジェクトと画像は残る。

## API（開発サーバー限定）

以下は `/__shiki/studio/` 配下。変更系の返り値は Project、round/build は `{job}`。
エラーは `{error}`、不正入力400・未発見404・実行中409。

| メソッド | パス | 用途 |
|---|---|---|
| GET / POST | `projects` | 一覧 `{id,title,stage,updated,cover}` / `{title,brief,refs?}` で作成 |
| GET | `project?id=` | 全データ |
| POST | `project/update` | `{id,title?,brief?}` |
| POST | `project/refs` / `project/refs/remove` | `{id,refs}` / `{id,path}` |
| POST | `project/round` | `{id,stage,feedback,count:{gpt,lora},director:{agent,model,effort},lora?:{weight}}` |
| POST | `project/rate` | `{id,item,rating,note?}`（-1 / 0 / 1） |
| POST | `project/choose` | `{id,keyVisual}` または `{id,studies}` |
| POST | `project/build` | `{id,agent,model,effort}` |
| GET | `file?id=&path=` | 保存画像のみ。ETagで再検証、パストラバーサルとリンクを拒否 |
| GET / POST | `lora/status` / `lora/start` | `{dir,installed,running,phase,loaded,message}` / 起動して準備を待つ |

motion は `count` 省略時 `{gpt:10,lora:0}`、LoRAは禁止。look は count 必須。
合計1〜12枚、各エンジン0枚は可。参照は最大8枚、各data URL最大12MB（PNG / JPEG / WebP / GIF）。
LoRA weight は0〜2、標準0.75。候補と参照の file はプロジェクト内の相対パス。
cover はそのまま表示できる相対URL。

## エンジンとジョブ

Claude または Codex の読み取り専用ディレクターが、哲学・好み・Pinterest傾向、評価履歴とFB、
参照画像、必要ならPinterestのコンタクトシートを読み、JSONで意図と候補を返す。
最後の fenced json（なければ最初のJSONオブジェクト）を解析し、枚数と内容が不正なら明示的に失敗する。
Claude の軽量フラグ、`ECC_HOOK_PROFILE=minimal` とサブスク用の環境変数除去を共用する。

- `gpt-image`: Codex の画像生成を1候補につき1回、1536×1024で実行。参照は `-i`。
  全プロジェクト合計で最大3並行。保存されなければ今回生成された最新PNGを回収する。
- `pinterest-lora`: `127.0.0.1:7860` の `/api/generate` → `/api/state` → `/gallery/<file>`。
  1344×768、1枚ずつ直列、409は待って再試行。スタイルとトリガーはサーバーに任せる。
  `SHIKI_LORA_DIR`（既定 `~/development/fumito_proj_2026/stableDiffusion_LoRA`）の
  `uv run --group eval --group ui scripts/10_ui_server.py` を必要時に起動。ロード上限5分、
  生成待ち上限15分、ログは `.agents/lora.log`。秘密ファイルは読み取らない。

ビルドはキービジュアルと1枚以上のstudyが必須。既存のcreate実行経路へ、固定idと承認済み画像を渡す。
成功した done の `createdWorkId` は必ずプロジェクトid。失敗・中止は `motion` に戻す。
シェーダーの実コンパイルは従来通りUIのプレビューで検証する。

UIは既存の `/__shiki/agent/events?job=`（SSE）、`cancel?job=`（POST）、`jobs` を使う。
`item` イベントの text は更新されたItemのJSON。queued → running → done/error をidで上書きする。
再接続は全イベントを再送するため、重複を許容すること。完了後はProjectを再取得する。
一部画像が失敗するとジョブはerrorになるが、成功画像は選定できる。
プロジェクトごとに1ジョブ。実行中も評価と文章更新は可能、参照変更・選定・次の実行は409。
キービジュアルを選び直すとstudy選定は解除される。
キャンセルは全子プロセス群を停止し、待機中の画像もerrorとして保存する。
すでに別途起動済みのLoRAサーバー内部で走る生成はAPIに停止機能がないため続くが、結果を取り込まない。

## ♥ ライブラリ

`project/rate` のたびに、♥ の画像を `library/likes/<project>/<item>.png` に複製し、同名の `.json`
（`project, projectTitle, item, title, stage, engine, prompt, motion?, note, likedAt`(epoch ms)`, file`）を書く。
♥ を外すと消す。起動時に全制作と突き合わせて揃える（以前の ♥ も保存される）。保存先は `SHIKI_LIBRARY_DIR` で変更可。
API：`GET likes`（`{dir, items}`）、`GET likes/file?path=<project>/<item>.png`、`POST likes/reveal`（Finder で開く）。

## Meshy：デザイン画像から3D

`GET meshy/status` は `{configured}`、`GET meshy/library?category=&search=` は無料のモーション一覧
（1時間キャッシュ）。`POST meshy/model` は `{id,item,rig?,actions?,polycount?,pose?,pbr?}` を受け、
既存のジョブ／SSEで `{job}` を返す。APIキーは環境変数またはリポジトリの `.env` の `MESHY_API_KEY`。
未設定時は「Meshy の API キーが .env にありません」。キーと署名付きアセットURLはログ・イベント・JSONへ保存しない。

完成済みのPNG候補を送り、約5秒ごとに進捗を通知する。テクスチャ付きGLBを
`models/<item>.glb`、サムネイルと追加アセットも即座にダウンロードする（リモートの保存期限は約3日）。
`rig:true` は人型向けの任意処理で `models/<item>-rigged.glb`、`actions` は `rig:true` が必要で
1〜10個の重複しないaction idから `models/<item>-anim.glb` を作る。複数モーションの追加GLBも保存する。
非人型はリグを省略し、エンジン側で動かす。polycountは100〜300000、poseは空文字／a-pose／t-pose、
pbrはboolean。リグ約5 credits、アニメーションは1 actionあたり3 credits、画像→3Dは設定・モデルに依存。
成功時のsummaryにAPIが返した `consumed_credits` の合計を含める。

`project.json` の `models` に `{id,item,file,thumb?,rigged?,anim?,actions?,tasks:{image,rig?,anim?},credits,createdAt}`
を保存する（file類はプロジェクト内の相対パス）。同じ候補の再生成はその候補の記録を置き換える。
各段階で保存し、後続の失敗でも完成済みモデルを残す。旧プロジェクトのmodelsは空配列として読める。
既存の `GET file?id=&path=` で画像とGLB（`model/gltf-binary`）を配信する。
プロジェクトごとに1ジョブ。キャンセルは通信・ポーリングを止めるが、Meshy側のタスクは継続することを通知する。
