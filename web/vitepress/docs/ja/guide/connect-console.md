---
title: Console からプログラムに接続する
description: integration で作ったプログラムから runtime API を提供し、Console に追加してチャットやタスクの確認を行う。
---

# Console からプログラムに接続する

Console が管理できるのは自分の Agent だけではありません。`mistermorph telegram` プロセスに接続するのと同じように、他の runtime を **endpoint** として接続できます。`integration` パッケージで作った Go プログラムも、runtime API を提供すれば endpoint のひとつになります。

接続すると、Console から次のことができます。

- プログラムとチャットする。メッセージはプログラムの `integration.Runtime` で実行され、プログラム独自のツール、prompt block、LLM 設定がそのまま使われます。
- プログラムが自分で実行したタスクを、チャットと並べて一覧する。
- モデル、LLM の使用量、監査ログ、ログを確認し、実行中のタスクを止める。

## 1. runtime API を提供する

`server.listen` と `server.auth_token` を設定し、`ServeRuntimeAPI` を呼びます。context が終わるまで戻りません。

```go
package main

import (
  "context"
  "os"
  "os/signal"

  "github.com/quailyquaily/mistermorph/integration"
)

func main() {
  cfg := integration.DefaultConfig()
  cfg.Set("llm.inference_provider", "openai")
  cfg.Set("llm.model", "gpt-5.4")
  cfg.Set("llm.api_key", os.Getenv("OPENAI_API_KEY"))
  cfg.Set("file_state_dir", "./state")

  // Console が接続する runtime API。
  cfg.Set("server.listen", "127.0.0.1:8790")
  cfg.Set("server.auth_token", os.Getenv("MY_AGENT_TOKEN"))

  rt, err := integration.NewChecked(cfg)
  if err != nil {
    panic(err)
  }

  // プログラム独自のツール。Console からのチャットでも使えます。
  reg := rt.NewRegistry()
  _ = reg.Register(&OrderStatusTool{})

  ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
  defer stop()
  if err := rt.ServeRuntimeAPI(ctx, integration.RuntimeAPIOptions{Registry: reg}); err != nil {
    panic(err)
  }
}
```

`OrderStatusTool` は `tools.Tool` を実装した任意の型です。[カスタムツール](/ja/guide/build-your-own-agent-advanced)を参照してください。

API は `/runtime` 以下で提供されるので、endpoint の URL は `http://127.0.0.1:8790/runtime` です。

## 2. Console に endpoint を追加する

Console の `config.yaml` に追加します。

```yaml
console:
  endpoints:
    - name: "My Agent"
      url: "http://127.0.0.1:8790/runtime"
      auth_token: "${MY_AGENT_TOKEN}"
```

Console の画面からも追加できます（**概要 → Agent を追加**）。endpoint は `Integration` ラベル付きで Console Local の隣に表示されます。開くとプログラムとチャットできます。

## プログラムが自分で実行するタスク

`RunTaskWithOptions` を `PersistTask: true` で実行すると、そのタスクもチャットと一緒に Console に表示されます。`TopicID` を指定すると、ひとつのトピックにまとまります。

```go
result, err := rt.RunTaskWithOptions(ctx, "今日の注文を確認し、遅れているものを報告して。", integration.RunTaskOptions{
  PersistTask: true,
  TopicID:     "order-reports",
  Registry:    reg,
})
```

これらのタスクを実行するときに `ServeRuntimeAPI` が動いている必要はありません。Console は `file_state_dir` 以下のタスクジャーナルから読みます。

## チャットの実行のされ方

- **履歴**：メッセージには同じトピックの直前のやり取り（最大 20 件）が付くので、トピックはひとつの会話として続きます。トピックなしで送ったメッセージは新しいトピックを作り、メッセージの内容がタイトルになります。
- **順序**：同じトピックのメッセージは順番に実行され、別のトピックは並行して実行されます。
- **キュー**：待機中と実行中のタスクは合わせて `server.max_queue` 件までです。それを超えるメッセージは、どれかが終わるまで受け付けられません。
- **タイムアウト**：各メッセージの実行時間は最大 `timeout` です（Console がより短い値を送った場合はそちら）。
- **停止**：Console でタスクを止めると、その実行がキャンセルされます。
- **終了**：context が終わると、`ServeRuntimeAPI` は自分が始めたチャットをキャンセルし、終了状態が記録されるまで待ちます。クラッシュで終わらなかったチャットは、次の起動時にキャンセル扱いになります。

回答は実行が終わった時点で表示されます。この endpoint では、まだ進行状況のライブ表示はありません。Console の設定エディタ、承認、ワークスペース、ファイル添付もこの endpoint では使えません。

## 設定

| キー | 役割 |
|---|---|
| `server.listen` | runtime API の待ち受けアドレス。必須。 |
| `server.auth_token` | Console が送る Bearer トークン。必須。 |
| `server.max_queue` | 同時に待機・実行できるタスク数の上限（既定 100）。 |
| `timeout` | チャットメッセージの最長実行時間（既定 1h）。 |
| `file_state_dir` | タスク、トピック、使用量、ログの保存先。プログラムごとに分けてください。 |

## セキュリティ

トークンがあれば、ツールを含めて Agent をすべて使えます。上の例のように、ソースコードには書かないでください。待ち受けはループバックアドレスにするか、Console が別のマシンにある場合は TLS リバースプロキシの後ろに置いてください。

## デモ

[`demo/embed-console`](https://github.com/quailyquaily/mistermorph/tree/master/demo/embed-console) は完成したプログラムです。独自の `get_order_status` ツールを持つ Example Shop のサポート Agent で、定期レポートのタスクも実行できます。起動すると、Console の設定に貼り付ける endpoint の設定を表示します。
