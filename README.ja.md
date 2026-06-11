*言語: [English](README.md) · **日本語***

# pi-frugal-orchestrator

[Pi コーディングエージェント](https://github.com/earendil-works/pi)向けの、**トークン倹約型オーケストレーションシステム**です。
トークンコストの高いメインモデルは**オーケストレーター**（指示を出し、結果を判断する）として働きつつ、
各タスクを「最もコスト効率の良い主体」に割り当てます（全作業を安価サブに委譲するのではなく**ハイブリッド**）。
フロンティアのメインが自らプランを執筆し、中級のメインが自ら実装し、リサーチ・調べもの・検証は
安価／ローカルなサブエージェントが担当します。

> 思想: 高価なモデルのコンテキストは軽く保つ。各タスクを、それを十分こなせる最も安価な主体へ割り当てる。

## なぜこれが効くか

| メリット | 仕組み |
|---|---|
| **メインモデルの精度 × サブモデルの速度・低コスト** | 高精度なメインモデル（Claude Opus, GPT Codex 等）が賢い判断と、フロンティア品質が要る作業（例: プラン執筆）を担い、安価なサブモデルは並列の力仕事（リサーチ・調べもの・検証）を担当します。 |
| **メインモデルのコンテキストが軽量** | オーケストレーターはサブエージェントの最終出力（最大 ~50 KB）だけを受け取ります。生データや中間差分を読まず、入出力両方のトークンを小さく保てます。 |
| **公平な検証** | verifier サブエージェントは実装とは別のクリーンなコンテキストで動作します。オーケストレーターは「自分で書いたものを自分でテストする」甘さの問題を回避し、公平な判断を保てます。 |
| **サブエージェントは単体運用より強い** | 軽量モデルは単体で使うと必要な情報にたどり着けなかったり、すぐに作業を諦めたりします。しかしメインモデルが正しい指示を与えれば、欲しい情報に確実にアクセスできます。サブエージェント化により、本来なら途中で止まるようなモデルでも長時間の作業が可能になります。 |

## 仕組み

4つのロール用スラッシュコマンドが、それぞれ専門のサブエージェントを spawn し、
ロール固有のオーケストレータープロンプトを注入します。モデルのルーティングは
単一の設定ファイルから取得されます。

| コマンド | 役割 | サブエージェント |
|---|---|---|
| `/research` | 読み取り専用の調査 | `Researcher` |
| `/planner` | 実装プランファイルを書く | **メインが自ら執筆** ＋ `Researcher`（read-only の checker） |
| `/implementer` | プランを実装する | **中級メインが自ら実装** ＋ `Researcher`（調べもの） ＋ `verifier`（最終 DoD 判定） |
| `/tester` | プランの Definition-of-Done を再検証する | `verifier` |

各コマンドは**永続的なロールモードに移行**します。`/research <タスク>` と1ステップで打つと、
ロールコンテキスト＋タスクをキックオフメッセージとして渡し作業を開始します。以降の
ターンでは毎回、ロールプロンプト＋`common-orchestrator.md` の共通ルール＋モデルルーティング
ブロックを、システムプロンプトの**末尾**に再注入します（キャッシュ可能な接頭辞を壊さないため）。
モードを抜けるには `/orchestrator:exit`（`/reload` でもモードは解除されます）。
モード外では何も注入されないため、未使用時のオーケストレーターのコンテキストコストはゼロです。

モデルルーティングは **`extensions/subagent-models.json`** に集約されています。順序付きの
`defaults` プール（N番目の同時 spawn は `defaults[N-1]` を使用）、プールを超えた spawn や
spawn エラー時に使う `defaultOverflow` モデル、そしてロール別オーバーライドを持ちます。

**モデル選定の指針:**
- **ローカルLLMがある場合**: `defaults[0]` にローカルモデルを指定します。
  無料で動作し、サブエージェントの大部分を処理できます。`defaultOverflow` にはクラウドモデルを
  設定します（並列時の超過やエラー時のフォールバック用）。
- **ローカルLLMがない場合**: `defaults` と `defaultOverflow` の両方に同じ安価なクラウドモデル
  （例: DeepSeek V4 Flash, Mimo）を指定しても問題ありません。実作業をサブエージェントに委譲するだけで
  メインモデルのトークンを節約できるため、ルーティングの仕組み自体が効果を発揮します。
- **ロール別オーバーライド**（例: `planner` → DeepSeek V4 Proなど少し重めのモデルにする）は任意ですが、特定のロールがモデルの
  特性を有利に活かせる場合は推奨します。

## 典型的な運用フロー

```
セッション 1
  起動 → /research <やりたいこと>
    → メインモデルが Researcher サブエージェントを spawn
    → （ローカルLLM や安価なクラウドモデルが 5〜20 分動作）
    → 調査結果をまとめて、質問・深掘りを経て設計を固めていく
    → 設計が固まったら /planner → プランファイルを保存
  （任意）/new で蓄積したコンテキストをリセット
                              ↓
セッション 2（クリーンなコンテキスト）
  （/implementer の前に /model で中級モデルへ切替）
  /implementer <プランファイル>
    → メインモデルがプランを読み、不足情報を Researcher で収集（調べもののみ）
    → メインモデル自身が実装（委譲しない）
    → verifier サブエージェント（read-only）が DoD を検証
    → FAIL ならメインモデルが修正 → 再検証（PASS までループ）
    → 完了 → /tester で独立した最終検証
```

**なぜセッションを分けるか?** セッション 1 では調査のコンテキストが蓄積されます。
実装をクリーンな状態から始めると、オーケストレーターは一度だけプランファイルをフルプライスで
再読しますが、プランファイル自体は小さいので再キャッシュのコストは小さく、調査の残滓が
実装の判断を汚染するのを防げます。

## 必要要件

- **Pi（`@earendil-works/pi-coding-agent`）`>= 0.74.0`**
- **`@tintinweb/pi-subagents` `>= 0.10.0`**（ロールコマンドが依存するサブエージェント
  `Agent` ツールを提供します）
- **Node `>= 22.19.0`**
- Pi の `models.json` に最低1つのモデルプロバイダ設定（例: 安価なワーカー用の
  ローカル `llama.cpp` / `vLLM` サーバ、加えて overflow 用の任意のクラウドモデル）。

## インストール

### 方法A — AI エージェントに任せる（推奨）

このリポジトリを clone した後、[`SETUP_FOR_AI_AGENT.md`](SETUP_FOR_AI_AGENT.md) を
あなたの AI コーディングエージェント（Pi 自身、Claude など）に渡してください。要件チェック、
`@tintinweb/pi-subagents` のインストール、必要なファイルだけの `~/.pi/agent/` へのコピー、
`subagent-models.json` のモデルID対話設定までを案内します。

### 方法B — 手動

1. エージェントファイルだけを Pi のエージェントディレクトリへコピーします（`.git/`、
   `.gitignore`、`LICENSE`、`README*.md`、`SETUP_FOR_AI_AGENT.md` は**コピーしない**）:
   - `agents/*.md` → `~/.pi/agent/agents/`
   - `extensions/*` → `~/.pi/agent/extensions/`
2. サブエージェントパッケージを Pi に導入します。Pi のパッケージに
   `@tintinweb/pi-subagents` を追加し（Pi のパッケージドキュメント参照）、`Agent`
   ツールを使えるようにします。
3. `~/.pi/agent/extensions/subagent-models.json` を編集し、プレースホルダのモデルID
   （`YOUR_LOCAL_MODEL`、`YOUR_REMOTE_MODEL`、`YOUR_CLOUD_MODEL`、`YOUR_REASONING_MODEL`）を、
   あなたの Pi `models.json` や `models.generated.js` に存在する軽量モデルのIDへ置き換えます。
4. `extensions/common-orchestrator.md` は extensions ディレクトリに置いたままにします。
   ロールコマンドがモード中に自動で読み込み・注入します（`AGENTS.md` に貼り付ける必要は
   ありません）。
5. Pi を `/reload` します（拡張とプロンプトは起動時に読み込まれます）。

## ファイル構成

```
agents/            # サブエージェント定義 — ロールフローで実際に spawn されるのは Researcher と verifier。
                   #   planner.md / implementer.md はレガシー（メインが直接執筆・実装するため未使用）
extensions/
  subagent-models.ts          # モデルルーティングロジック＋ロールコマンド登録
  subagent-models.json        # モデルルーティング設定（プレースホルダを編集）
  common-orchestrator.md      # 共通オーケストレータールール
  research-orchestrator.md    # /research プロンプト
  planner-orchestrator.md     # /planner プロンプト
  implementer-orchestrator.md # /implementer プロンプト
  tester-orchestrator.md      # /tester プロンプト
  session-tab-title.ts        # UI: セッションごとのタブタイトル
  subagent-context-watchdog.ts# コンテキスト上限が近いサブエージェントを締める
```

## ライセンス

MIT © [hiraghi](https://github.com/hiraghi) — [LICENSE](LICENSE) を参照。
