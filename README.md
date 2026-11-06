# plamo-ja

Claude Code に英語で応答させ、その応答をローカルで動かす [PLaMo 3 Translate](https://huggingface.co/pfnet) で日本語に翻訳して表示する Claude Code のプラグイン (mod) です。

- `/plamo on` で有効になります。Claude への「英語で応答する」指示は、その次に送る入力に 1 回だけ添えます (コマンドだけでは Claude は応答しません)
- 応答の英文を OpenAI 互換サーバの Completions API に送り、返ってきた日本語訳で表示を置き換えます。会話の履歴は英語のまま残ります
- それまでの訳 (英文と訳文の組、最大 8000 字ほど) を文脈として一緒に送ります
- AskUserQuestion の質問と選択肢は、日本語に訳してから表示します
- `/plamo on-input` では、さらに自分の日本語の入力も英語に訳してから Claude に送ります。画面には入力したとおりの日本語を表示します
- `/plamo off` で英語の表示に戻ります。訳はセッション内に残るので、もう一度 `/plamo on` にすると訳し直さずに日本語に戻ります
- 翻訳中は応答の末尾に `⏳ PLaMo 翻訳中…`、失敗時は `⚠ PLaMo 翻訳に失敗しました (理由)` を表示します。失敗した応答は次のメッセージ送信時に再試行します

## フォーク元からの変更点

このリポジトリは [kikuchy/plamo-ja-mod](https://github.com/kikuchy/plamo-ja-mod) (v0.2.0) のフォークです。このフォークで加えた変更は次のとおりです。

- `/plamo` コマンドを追加し、`on` / `on-input` / `off` で翻訳を切り替えるようにした。セッション開始時は無効
- 英語で応答する指示を、`/plamo` で切り替えた後の最初の入力に 1 回添えるようにした
- `off` にすると英語の表示に戻り、もう一度有効にすると前の訳を再利用するようにした
- 翻訳を 1 回の応答の受信が終わってから始めるようにした (`turn.step` で検知)
- それまでの訳を最大 8000 字ほど文脈として送るようにした
- fullscreen 表示では、画面に映っている過去の応答だけを翻訳するようにした
- 日本語で書かれた応答は翻訳せずに表示するようにした
- AskUserQuestion の質問と選択肢を日本語に訳してから表示するようにした
- `/plamo on-input` で、入力した日本語を英訳して送るようにした
- llama-server 向けに、リクエストに `cache_prompt: true` と `id_slot: 0` を付けるようにした

## 使い方

```
/plamo on        # 日本語表示を有効にし、Claude に英語で答えるよう指示する (引数なしも同じ)
/plamo on-input  # on に加えて、入力も英訳して送る
/plamo off       # 英語の表示に戻し、Claude に日本語で答えるよう指示する
```

セッションを始めた時点では無効です。

## 必要なもの

- OpenAI 互換の Completions API (`POST /v1/completions`) を提供するローカルサーバ。このフォークは llama.cpp の llama-server で動作確認しています。フォーク元は [LM Studio](https://lmstudio.ai/) で動作確認されています。このフォークの変更を LM Studio で動かせるか (`cache_prompt` と `id_slot` を受け付けるか) は確認していません
- PLaMo 3 Translate の GGUF 版モデル (0.8B / 2B / 8B / 31B)。LM Studio では MLX 版は `trust_remote_code` が必要なため読み込めません

LM Studio の場合:

1. PLaMo 3 Translate の GGUF 版をダウンロードする
2. Developer タブでサーバを起動する (デフォルトのポートは 1234)。モデルは最初のリクエストで自動的に読み込まれます

## インストール

Claude Code のターミナルセッションで:

```
/plugin install plamo-ja --marketplace kat0h/plamo-ja-mod
```

マーケットプレイスの追加を聞かれたら `y`、続けてスコープを選びます。

シェルから:

```bash
claude plugin install plamo-ja --marketplace kat0h/plamo-ja-mod
```

デスクトップアプリでは `/plugin` が使えないため、プロンプト欄横の + → Plugins → Add marketplace に `kat0h/plamo-ja-mod` を入力し、Add plugin で追加します。

## 設定

インストール時、または `/config` で変更できます。

| 項目 | デフォルト | 内容 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:1234/v1` | サーバの API ベース URL。末尾に `/completions` を付けて呼び出します |
| `model` | `plamo-3-translate-0.8b` | サーバ上のモデル名 (LM Studio ではモデルキー) |
| `form` | `polite` | 訳文の文体。`polite` でです・ます調、`plain` でだ・である調 |

設定は `~/.claude/settings.json` の `pluginConfigs["plamo-ja@plamo-ja"].options` に保存されます。

## 制限

- 翻訳結果はセッション内のメモリにのみ保持します。セッションを開き直すと過去の応答は再翻訳されます
- 有効・無効の状態もセッション内だけです。開き直すと無効に戻ります
- 過去の応答は、画面に映っているものだけを翻訳します (スクロールで画面に入ったら翻訳します)。どの応答が映っているかは fullscreen 表示 (`"tui": "fullscreen"`) でしか分からないため、それ以外の表示ではすべての応答が対象になります
- 英語で答える指示は `/plamo on` の後の最初の入力に 1 回添えるだけです。`/compact` の後などに Claude が日本語で答えるようになったら、もう一度 `/plamo on` を実行してください
- コードブロックも含めて応答全体を翻訳します
- `on-input` の英訳は確認なしでそのまま送ります。誤訳で指示の意図がずれることがあります。英訳に失敗したときは日本語の原文のまま送ります
- `on-input` から `on` や `off` に切り替えると、それまでの入力は送った英語のまま表示されます
- `on-input` で英訳するのは、入力欄から送った日本語を含む入力だけです。スラッシュコマンドは訳しません
- 翻訳は Claude の 1 回の応答 (ツール呼び出しまで、または最後まで) を受け取り終えてから始めます。書いている途中の文面は英語のまま表示します
- llama-server のプロンプトキャッシュを効かせるため、リクエストに `cache_prompt: true` と `id_slot: 0` を付けます。複数のセッションで同時に使うと、スロット 0 を取り合ってキャッシュが外れやすくなります

## ライセンス

このプラグインのコードは [LICENSE](LICENSE) に従います。PLaMo 3 Translate のモデルは PLaMo Community License に従います。
