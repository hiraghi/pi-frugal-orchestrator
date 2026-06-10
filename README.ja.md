*言語: [English](README.md) · **日本語***

# pi-frugal-orchestrator

[Pi コーディングエージェント](https://github.com/earendil-works/pi)向けの、**トークン倹約型オーケストレーションシステム**です。
トークンコストの高いメインモデルは純粋に**オーケストレーター**（指示を出し、結果を判断するだけ）に徹し、
実作業のトークン（リサーチ・プランニング・実装・テスト）は、ロールコマンドを通じて
安価／ローカルなサブエージェントモデルへ委譲します。

> 思想: 高価なモデルのコンテキストは軽く保つ。サブエージェントの結果だけを受け取ることでコンテキスト汚染を抑える。

## 仕組み

4つのロール用スラッシュコマンドが、それぞれ専門のサブエージェントを spawn し、
ロール固有のオーケストレータープロンプトを注入します。モデルのルーティングは
単一の設定ファイルから取得されます。

| コマンド | 役割 | サブエージェント |
|---|---|---|
| `/research` | 読み取り専用の調査 | `Researcher` |
| `/planner` | 実装プランファイルを書く | `planner`（writer）＋ `Researcher`（checker） |
| `/implementer` | プランを実装し自己検証する | `implementer` ＋ `Researcher` |
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
agents/            # サブエージェント定義 (Researcher, planner, implementer, verifier)
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
