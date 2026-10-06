---
title: MCP
description: MCP を設定し、ローカル Agent のツールループへ接続する。
---

# MCP

Mister Morph は MCP へ接続し、MCP が提供するツールを同じ tool-calling ループへ登録できます。

## ツール名マッピング

MCP ツールは次の名前で登録されます: `mcp_<server_name>__<tool_name>`

例: `mcp_example__read_file`

## 対応トランスポート

- `stdio`（デフォルト）
- `http`

## 設定

```yaml
mcp:
  servers:
    - name: example_cmd
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/example_cmd", "/tmp"]
      allowed_tools: []

    - name: remote
      type: http
      url: "https://mcp.example.com/mcp"
      headers:
        Authorization: "Bearer ${MCP_REMOTE_TOKEN}"
      allowed_tools: ["search"]
```

内容:

- `name`: `[A-Za-z][A-Za-z0-9_-]*` に一致する名前。先頭は英字、以降は英字・数字・アンダースコア・ハイフンのみ。先頭や末尾を含め、空白は使えない。無効なエントリにも同じ規則が適用される。
- `enable`: その server を有効または無効にする。無効な server はオフで、接続されない。
- `on_demand`: `true` のとき、有効な server を起動時には接続しない。タスクに `$mcp_<name>` と書くと読み込まれる（下記参照）。
- `allowed_tools`: その server で利用可能なツールを制限する。空なら制限しない

名前は大文字小文字を区別せずに一意である必要がある。`GitHub` と `github` は衝突し、起動時に両方ともスキップされる。

## タスクごとに server を読み込む

server に `on_demand: true` を付け、タスクに `$mcp_<name>` と書く:

```yaml
mcp:
  servers:
    - name: github-work
      on_demand: true
      type: http
      url: "https://mcp.example.com/mcp"
      allowed_tools: ["search_repositories", "get_issue"]
```

```text
$mcp_github-work このバグについて書かれた issue を探して。
```

- server はそのタスクだけのために、モデルへの最初のリクエストの前に接続される。ツール（`mcp_github-work__get_issue` など）はタスクの間ずっと使え、タスクが終わると接続は閉じる。
- 名前は大文字小文字を区別せずに照合する。同じ名前のスキル（`mcp_github-work`）があればスキルが優先される。
- チャットのメッセージ、Console のチャット、CLI タスク、cron と TODO のタスク、heartbeat、他の Agent からの引き継ぎで使える。Telegram の引用メッセージ内の `$mcp_` は無視される。
- 起動時に接続された server は参照しなくても使える。起動時に接続に失敗した server は、参照したタスクで再接続を試みる。
- 30 秒以内に接続できない場合や、許可されたツールがない場合、タスクは server 名を含むエラーで失敗する。

## ツール検索

MCP のツールが多いと、すべてのリクエストにその定義が含まれてしまう。ツール検索（既定で有効）は、モデルが必要とするまで MCP のツールを隠す:

```yaml
tools:
  tool_search:
    enabled: true       # 既定値。false にすると全 MCP ツールを毎回送る
    always_loaded: []   # 常に表示しておく MCP ツール名
```

`tool_search` は、見つける対象（MCP のツール、または有効な on-demand server）があるときだけ提供される。MCP がなければリクエストは変わらない。

- 組み込みツールは常に表示される。MCP のツールは隠され、モデルが `tool_search` ツールで名前や説明から見つける。
- 検索に server（`server`）を指定すると、有効な on-demand server をそのタスクのために接続し、そのツールを検索する。接続前に見つけられるよう、server に `description` を付けておく。
- 見つかったツールは次のステップから呼び出せ、会話が続く間は表示されたままになる。`/reset` で忘れる。
- `$mcp_<name>` は従来どおり、その server の許可されたツールすべてを最初のリクエストから表示する。

## ライフサイクル

1. `mcp.servers` を読む
2. 有効かつ正しく、`on_demand` でないサーバーへ接続
3. ツール一覧を取得
4. ローカル registry へアダプト登録
5. 終了時に MCP session を close
