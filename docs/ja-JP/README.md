# Mister Morph

統合 Agent CLI と再利用可能な Go エージェントコア。

## 目次

- [Mister Morph を選ぶ理由](#why-mistermorph)
- [クイックスタート](#quickstart)
- [対応モデル](#supported-models)
- [デーモンモード](#daemon-mode)
- [Telegram ボットモード](#telegram-bot-mode)
- [他プロジェクトへの組み込み](#embedding-to-other-projects)
- [組み込みツール](#built-in-tools)
- [Skills（スキル）](#skills)
- [セキュリティ](#security)
- [トラブルシュート](#troubleshoots)
- [デバッグ](#debug)
- [設定](#configuration)

<a id="why-mistermorph"></a>
## Mister Morph を選ぶ理由

このプロジェクトの主な特徴は次のとおりです。

- 🧩 **再利用しやすい Go コア**: Agent を CLI として実行するだけでなく、ライブラリやサブプロセスとして他アプリへ組み込めます。
- 🤝 **Mesh Agent Exchange Protocol（MAEP）**: 複数の Agent を運用し、相互にメッセージをやり取りしたい場合に MAEP を使えます。信頼状態と監査トレイルを備えた P2P プロトコルです（[../maep.md](../maep.md) を参照、WIP）。
- 🔒 **実運用を意識した安全なデフォルト**: プロファイルベースの資格情報注入、Guard によるマスキング、アウトバウンドポリシー制御、監査トレイル付きの非同期承認を提供します（[../security.md](../security.md) を参照）。
- 🧰 **実用的な Skills システム**: `file_state_dir/skills` から `SKILL.md` を検出して注入でき、シンプルな on/off 制御に対応します（[../skills.md](../skills.md) を参照）。
- 📚 **学習しやすい構成**: 学習重視の Agent プロジェクトとして設計されており、`docs/` に詳細な設計ドキュメントがあり、`--inspect-prompt` や `--inspect-request` など実用的なデバッグ機能も用意されています。

<a id="quickstart"></a>
## クイックスタート

### ステップ 1: インストール

方法 A: GitHub Releases からビルド済みバイナリを取得（本番用途では推奨）。

```bash
curl -fsSL -o /tmp/install-mistermorph.sh \
  https://raw.githubusercontent.com/quailyquaily/mistermorph/main/scripts/install-release.sh
bash /tmp/install-mistermorph.sh v0.1.0
```

インストーラースクリプトは次の実行方法に対応しています。

- `bash install-release.sh <version-tag>`
- `INSTALL_DIR=$HOME/.local/bin bash install-release.sh <version-tag>`

方法 B: Go でソースからインストール。

```bash
go install github.com/quailyquaily/mistermorph@latest
```

### ステップ 2: Agent の必須ファイルと組み込みスキルをインストール

```bash
mistermorph install
# または
mistermorph install <dir>
```

`install` コマンドは、必須ファイルと組み込みスキルを `~/.morph/skills/`（または `<dir>` で指定したディレクトリ）にインストールします。

### ステップ 3: API キーを設定

`~/.morph/config.yaml` を開き、利用する LLM provider の API キーを設定します。以下は OpenAI の例です。

```yaml
llm:
  provider: "openai"
  endpoint: "https://api.openai.com/v1"
  model: "gpt-5.2"
  api_key: "YOUR_OPENAI_API_KEY_HERE"
```

Mister Morph は Azure OpenAI、Anthropic Claude、AWS Bedrock などにも対応しています（詳細は `../../assets/config/config.example.yaml` を参照）。

### ステップ 4: 初回実行

```bash
mistermorph run --task "Hello!"
```

<a id="supported-models"></a>
## 対応モデル

> モデル対応状況は、モデル ID・provider endpoint の機能・tool-calling の挙動によって変わる場合があります。

| Model family | Model range | Status |
|---|---|---|
| GPT | `gpt-5*` | ✅ Full |
| GPT-OSS | `gpt-oss-120b` | ✅ Full |
| Claude | `claude-3.5+` | ✅ Full |
| DeepSeek | `deepseek-3*` | ✅ Full |
| Gemini | `gemini-2.5+` | ✅ Full |
| Kimi | `kimi-2.5+` | ✅ Full |
| MiniMax | `minimax* / minimax-m2.5+` | ✅ Full |
| GLM | `glm-4.6+` | ✅ Full |
| Cloudflare Workers AI | `Workers AI model IDs` | ⚠️ Limited (no tool calling) |

<a id="telegram-bot-mode"></a>
## Telegram ボットモード

Telegram から Agent と会話できるように、Telegram ボット（ロングポーリング）を起動します。

`~/.morph/config.yaml` を編集し、Telegram ボットトークンを設定します。

```yaml
telegram:
  bot_token: "YOUR_TELEGRAM_BOT_TOKEN_HERE"
  allowed_chat_ids: [] # 許可する chat id をここに追加
```

```bash
mistermorph telegram --log-level info
```

補足:
- `/id` で現在の chat id を取得し、`allowed_chat_ids` に追加して許可リスト化します。
- グループでは `/ask <task>` を使えます。
- グループでは、ボットへの返信または `@BotUsername` メンションでも応答します。
- ファイルを送信すると `file_cache_dir/telegram/` に保存され、Agent が処理できます。`telegram_send_file` でキャッシュ済みファイルを送信でき、`telegram_send_voice` で `file_cache_dir` 配下のローカル音声ファイルも送信できます。
- 最後に読み込んだスキルはチャット単位で保持されるため、後続メッセージでも `SKILL.md` の文脈が維持されます。`/reset` でクリアできます。
- `telegram.group_trigger_mode=smart` は、グループ内の各メッセージを addressing LLM で判定します。受理には `addressed=true` かつ `confidence >= telegram.addressing_confidence_threshold`、`interject > telegram.addressing_interject_threshold` が必要です。
- `telegram.group_trigger_mode=talkative` も各メッセージを addressing LLM で判定しますが、`addressed=true` は必須ではありません（confidence/interject の閾値は適用されます）。
- チャットで `/reset` を実行すると会話履歴をクリアできます。
- 既定では複数チャットを並列処理しつつ、各チャット内は直列で処理します（設定: `telegram.max_concurrency`）。

<a id="daemon-mode"></a>
## デーモンモード

ローカル HTTP デーモンを起動し、タスクを順番に（1 件ずつ）受け付けます。タスクごとにプロセスを再起動する必要がなくなります。

デーモンを起動:

```bash
export MISTER_MORPH_SERVER_AUTH_TOKEN="change-me"
mistermorph serve --server-port 8787 --log-level info
```

タスクを送信:

```bash
mistermorph submit --server-url http://127.0.0.1:8787 --auth-token "$MISTER_MORPH_SERVER_AUTH_TOKEN" --wait \
  --task "Summarize this repo and write to ./summary.md"
```

<a id="embedding-to-other-projects"></a>
## 他プロジェクトへの組み込み

代表的な統合方法は 2 つです。

- Go ライブラリとして利用: `../../demo/embed-go/`
- CLI サブプロセスとして利用: `../../demo/embed-cli/`

<a id="built-in-tools"></a>
## 組み込みツール

Agent が利用できる主要ツール:

- `read_file`: ローカルのテキストファイルを読み取る。
- `write_file`: `file_cache_dir` または `file_state_dir` 配下にテキストファイルを書き込む。
- `bash`: シェルコマンドを実行する（デフォルトでは無効）。
- `url_fetch`: 認証プロファイル指定に対応した HTTP 取得。
- `web_search`: Web 検索（DuckDuckGo HTML）。
- `plan_create`: 構造化された計画を生成。

Telegram モードでのみ利用できるツール:

- `telegram_send_file`: Telegram にファイルを送信。
- `telegram_send_voice`: Telegram に音声メッセージを送信。
- `telegram_react`: Telegram で絵文字リアクションを追加。

詳しくは [../tools.md](../tools.md) を参照してください。

<a id="skills"></a>
## Skills（スキル）

`mistermorph` は `file_state_dir/skills` を再帰的に探索し、選択した `SKILL.md` の内容を system prompt に注入できます。

デフォルトでは `run` は `skills.mode=on` を使い、`skills.load` と任意の `$SkillName` 参照（`skills.auto=true`）を読み込みます。

ドキュメント: [../skills.md](../skills.md)

```bash
# 利用可能なスキル一覧
mistermorph skills list
# run コマンドで特定スキルを使用
mistermorph run --task "..." --skills-mode on --skill skill-name
# リモートスキルをインストール
mistermorph skills install <remote-skill-url>
```

### Skills のセキュリティ機構

1. インストール監査: リモートスキルをインストールする際、Mister Morph は内容を事前表示し、基本的なセキュリティ監査（例: スクリプト内の危険コマンド検出）を行ったうえでユーザー確認を求めます。
2. Auth profiles: スキルは `auth_profiles` フィールドで必要な認証プロファイルを宣言できます。ホスト側で対応する auth profile が設定されているスキルのみ Agent が利用するため、シークレット漏えいを防ぎやすくなります（`../../assets/skills/moltbook` と設定ファイル内の `secrets` / `auth_profiles` セクションを参照）。

<a id="security"></a>
## セキュリティ

systemd ハードニングとシークレット管理の推奨事項は [../security.md](../security.md) を参照してください。

<a id="troubleshoots"></a>
## トラブルシュート

既知の問題と回避策: [../troubleshoots.md](../troubleshoots.md)

<a id="debug"></a>
## デバッグ

### ログ

`--log-level` 引数でログレベルと形式を設定できます。

```bash
mistermorph run --log-level debug --task "..."
```

### 内部デバッグ情報のダンプ

`--inspect-prompt` / `--inspect-request` を指定すると、デバッグ用に内部状態を出力できます。

```bash
mistermorph run --inspect-prompt --inspect-request --task "..."
```

これらの引数を使うと、最終的な system/user/tool プロンプトと、LLM のリクエスト/レスポンス JSON 全体がプレーンテキストとして `./dump` ディレクトリに保存されます。

<a id="configuration"></a>
## 設定

`mistermorph` は Viper を使用しているため、フラグ、環境変数、設定ファイルのいずれでも設定できます。

- 設定ファイル: `--config /path/to/config.yaml`（`.yaml/.yml/.json/.toml/.ini` をサポート）
- 環境変数プレフィックス: `MISTER_MORPH_`
- ネストしたキー: `.` と `-` を `_` に置換（例: `tools.bash.enabled` → `MISTER_MORPH_TOOLS_BASH_ENABLED=true`）

### CLI フラグ

**グローバル（全コマンド共通）**
- `--config`
- `--log-level`
- `--log-format`
- `--log-add-source`
- `--log-include-thoughts`
- `--log-include-tool-params`
- `--log-include-skill-contents`
- `--log-max-thought-chars`
- `--log-max-json-bytes`
- `--log-max-string-value-chars`
- `--log-max-skill-content-chars`
- `--log-redact-key`（繰り返し指定可）

**run**
- `--task`
- `--provider`
- `--endpoint`
- `--model`
- `--api-key`
- `--llm-request-timeout`
- `--interactive`
- `--skills-dir`（繰り返し指定可）
- `--skill`（繰り返し指定可）
- `--skills-auto`
- `--skills-mode`（`off|on`）
- `--max-steps`
- `--parse-retries`
- `--max-token-budget`
- `--timeout`
- `--inspect-prompt`
- `--inspect-request`

**serve**
- `--server-bind`
- `--server-port`
- `--server-auth-token`
- `--server-max-queue`

**submit**
- `--task`
- `--server-url`
- `--auth-token`
- `--model`
- `--submit-timeout`
- `--wait`
- `--poll-interval`
