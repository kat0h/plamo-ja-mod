# plamo-ja

Claude Code に英語で応答させ、その応答をローカルで動かす [PLaMo 3 Translate](https://huggingface.co/pfnet) で日本語に翻訳して表示する Claude Code のプラグイン (mod) です。

- Claude には「英語で応答する」指示をプロンプトごとに付けます
- 応答の英文を OpenAI 互換サーバの Completions API に送り、返ってきた日本語訳で表示を置き換えます。会話の履歴は英語のまま残ります
- 翻訳中は応答の末尾に `⏳ PLaMo 翻訳中…`、失敗時は `⚠ PLaMo 翻訳に失敗しました (理由)` を表示します。失敗した応答は次のメッセージ送信時に再試行します

## 必要なもの

- OpenAI 互換の Completions API (`POST /v1/completions`) を提供するローカルサーバ。[LM Studio](https://lmstudio.ai/) で動作確認しています
- PLaMo 3 Translate の GGUF 版モデル (0.8B / 2B / 8B / 31B)。LM Studio では MLX 版は `trust_remote_code` が必要なため読み込めません

LM Studio の場合:

1. PLaMo 3 Translate の GGUF 版をダウンロードする
2. Developer タブでサーバを起動する (デフォルトのポートは 1234)。モデルは最初のリクエストで自動的に読み込まれます

## インストール

Claude Code のターミナルセッションで:

```
/plugin install plamo-ja --marketplace kikuchy/plamo-ja-mod
```

マーケットプレイスの追加を聞かれたら `y`、続けてスコープを選びます。

シェルから:

```bash
claude plugin install plamo-ja --marketplace kikuchy/plamo-ja-mod
```

デスクトップアプリでは `/plugin` が使えないため、プロンプト欄横の + → Plugins → Add marketplace に `kikuchy/plamo-ja-mod` を入力し、Add plugin で追加します。

## 設定

インストール時、または `/config` で変更できます。

| 項目 | デフォルト | 内容 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:1234/v1` | サーバの API ベース URL。末尾に `/completions` を付けて呼び出します |
| `model` | `plamo-3-translate-0.8b` | サーバ上のモデル名 (LM Studio ではモデルキー) |
| `form` | `polite` | 訳文の文体。`polite` でです・ます調、`plain` でだ・である調 |

設定は `~/.claude/settings.json` の `pluginConfigs["plamo-ja"].options` に保存されます。

## 制限

- 翻訳結果はセッション内のメモリにのみ保持します。セッションを開き直すと過去の応答は再翻訳されます
- 応答のストリーミング中は途中の文面も翻訳対象になるため、長い応答では翻訳の完了が応答の完了より遅れます

## ライセンス

このプラグインのコードは [LICENSE](LICENSE) に従います。PLaMo 3 Translate のモデルは PLaMo Community License に従います。
