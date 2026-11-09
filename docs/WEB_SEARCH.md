# Keyless web search

`feat/web-search` is stacked on `feat/tool-calling`. Review its web-only diff against that branch; once the tool-calling foundation is merged upstream, retarget/rebase the web-search contribution onto upstream main. Neither branch depends on the personal `dev/integrated` branch. No PRs or merges into other feature branches are made by this implementation.

## Usage

Enable **Use tools**, then enable **web_search** in Settings → Tool calling. Search remains disabled by default because newly registered tool names require explicit selection. Existing installations and calculator settings retain their values. No API key or account is required.

Try: “Search the web for the latest Python release and cite your sources.” Expand the tool activity to see `{ query, count }` and the result data. `count` is optional (default 5, maximum 5). Queries must be nonblank and at most 400 characters. Stop and existing per-tool timeout/round controls apply.

The tool returns `{ provider, query, results: [{ title, url, snippet, source }] }`. These are search snippets, not fetched articles or independent verification. A tool-capable model/template is still required. Citation quality and whether the model requests a search depend on that model; the app does not fabricate tool calls from prose.

## Architecture and privacy

- `src/main/web-search.ts` defines the registered tool, bounded query/count schema, and sanitized result shape.
- `src/main/keyless-search.ts` supplies DuckDuckGo HTML search, Bing fallback, inert HTML parsing and request policy. `htmlparser2` is the only new direct dependency. The implementation is separate from the inference loop and registry infrastructure.
- `createToolRegistry()` registers the tool alongside the calculator. Existing IPC, result messages, cancellation and the activity UI are reused. No additional execution IPC or HTTP/LAN endpoint is introduced.
- Network destinations are fixed to `https://html.duckduckgo.com/html/` and `https://www.bing.com/search`. Only query parameters are sent, not the entire message history or system prompt. However, a model may include chat information in its search query. The providers receive that query and the connection's usual network metadata. There is no cookie jar, login, API key, or telemetry.
- Redirects are rejected, rather than followed to arbitrary destinations. Result redirect wrappers are decoded locally into HTTP(S) source URLs; those URLs are returned as data and never visited by the tool. No page fetching, browser automation, scripts, or remote images are supported.
- Snippets are untrusted input returned as ordinary `role: tool` JSON through the existing loop, never as system instructions. HTML is parsed for text, not executed or injected into the renderer. This does not guarantee that every model will resist prompt injection; source material must still be treated critically.

## Request policy and limits

DuckDuckGo is tried first, then Bing if it is refused, unavailable, unrecognized, or has no results. A successful fallback identifies its actual source in each result.

There is one active search per registry instance. Requests to each source are at least three seconds apart and limited to eight per minute. Challenges, refusal responses, network errors, unknown page layouts and invalid content cause a per-source cooldown: 1, 2, 4, 8, then at most 10 minutes. Retry-After can extend that interval, up to 24 hours. No automated challenge solving or retries against a refusing source are attempted during cooldown.

Each network request has a 3.5-second deadline, also bounded by the existing overall tool execution timeout. Stop interrupts requests and pacing waits. Responses are limited to 1 MiB and must be HTML. Results are deduplicated and capped at five, with 300-character titles, 2,048-character URLs and 1,200-character snippets. Results and recognized empty-result responses are cached for 30 minutes in a bounded 50-query in-memory cache. Query keys normalize whitespace/case. Cache and cooldowns disappear on app restart; no search log is written to disk.

Real no-result pages yield an empty result list. Blocks, challenges and unknown HTML do not silently masquerade as no results. If no usable provider remains, the ordinary tool error explains that search is temporarily unavailable. Existing round limits prevent an unlimited model retry loop; provider cooldowns avoid repeated network requests.

## Reliability and validation

Like Strata's default search approach, this uses keyless search-result pages instead of a supported search API. The architectural reference is [Strata's search adapter](https://github.com/niko1221/strata/blob/504b143342a9fe1aa8320a7b31e11f5c0ac265c3/apps/host/server/web-search-ddg.mjs). This branch does not import Strata code or depend on Strata; it uses an HTML parser rather than copying its scraping implementation.

Search providers may refuse automated requests or change their HTML. The adapter identifies itself as HFRunner and does not impersonate a browser to bypass challenges. Cache, pacing and fallback improve usability but cannot guarantee availability. If dependable search is required later, a documented keyed provider can implement the same SearchProvider interface without changing the inference loop.

Tests cover the registered schema, disabled state, bounded data, source URL validation, an entire model/search/result/final-answer round trip, DDG/Bing parsing, deduplication, ads, redirect decoding, fallback, caching/expiry/eviction, pacing/rate limits, Retry-After, cooldown escalation, parallel-request rejection, cancellation, response size/content checks and challenge handling. HTTP responses are fixtures/mocks. The live cloud probe was blocked by the environment proxy with CONNECT HTTP 403 for both search hosts; it does not establish live provider success or failure on a normal Windows connection.

The branch's Windows workflow builds installer and portable artifacts named with `feat-web-search` and the commit SHA. Manually test actual searches, cancellation and a real model's citations from those packages before claiming live-model search support.

## 日本語

このブランチは `feat/tool-calling` を土台とする検索機能のみの差分です。「ツールを使用」と「設定 → ツール呼び出し → web_search」を明示的に有効にしてください。API キーは不要です。DuckDuckGo を優先し、拒否・失敗・該当なしの場合は Bing を試します。結果はタイトル、URL、要約、検索元の情報です。

検索語だけを外部に送信しますが、モデルが会話の情報を検索語に含める可能性があります。機密情報を検索させないでください。リンク先の取得、スクリプト実行、画像の読み込みは行いません。結果は信頼されていないツールのデータであり、システム指示には変換しません。LAN 経由の実行権限も追加しません。

同時検索数、送信間隔、回数、応答サイズ、実行時間を制限します。検索結果はメモリ内に 30 分間キャッシュし、最大 50 件です。アクセス拒否や未知の HTML には待機時間を設け、CAPTCHA は回避しません。HTML の変更やプロバイダーの制限で利用できなくなる場合があります。API のような可用性は保証できません。クラウド環境からの実接続はプロキシの HTTP 403 で遮断されたため、Windows ビルドで別途確認してください。
