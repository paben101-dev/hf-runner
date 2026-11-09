# Tool calling architecture

This feature is independent of conversation history, Markdown, web search, MCP, and file access. It retains the baseline renderer's ordinary chat path when tools have never been enabled in that conversation. No tool execution endpoint is added to the HTTP inference server or LAN gateway.

## Data flow and permissions

1. The desktop renderer invokes `tools:start` with a session UUID, expected model ID and raw OpenAI-style conversation. Only the owning BrowserWindow can start or cancel a session.
2. The main process reads persisted tool preferences, checks the running model and `/props` capability advertisement, and supplies definitions only for enabled, statically registered tools. Unknown capability metadata fails closed. The system prompt comes from existing settings, not from tool output.
3. `runToolChat` streams content/reasoning and assembles indexed `delta.tool_calls` fragments. A complete `finish_reason: tool_calls` is required before execution. Prose and truncated arguments are never guessed to be calls.
4. The main-process registry parses JSON and validates arguments against the tool's JSON Schema using Ajv (draft-07, strict mode). Unknown/disabled names, invalid arguments, thrown errors, oversized results, timeouts and cancellation become structured results.
5. Assistant calls and their corresponding `role: tool` result messages are appended to context. Results remain untrusted JSON data, never system/developer messages or executable code. Inference continues until an ordinary response or a limit/error.
6. Streaming text/reasoning updates are throttled to about 40 ms. Requested/running/completed calls appear as collapsible arguments/results. Usage from participating inference rounds is accumulated when provided by the backend. Stop aborts network generation and cooperative tool handlers; incomplete batches receive cancelled results so subsequent context is well-formed.

Defaults: master disabled, no tools selected, three tool-execution rounds, 10-second tool timeout. Persisted controls are clamped to 1–8 rounds and 100–30,000 ms. Sessions have a five-minute ceiling, at most 16 calls per round, 64-KiB argument/result limits, and bounded stream/context sizes. Calls execute sequentially, preserving order. Model stop/change, window destruction or changing tool preferences cancels a session.

The schema and handler are trusted application code, not supplied by models or IPC. Asynchronous handlers must honor AbortSignal. Timeouts stop waiting and signal cancellation; they cannot forcibly undo side effects or interrupt synchronous CPU-bound JavaScript. Future expensive/uncooperative handlers should use an isolated worker. There is no shell/eval execution or generic filesystem/network tool.

## Registering a future tool

Add registration in `createToolRegistry()` in `src/main/tools.ts`. There is no need to modify the inference loop:

```ts
registry.register({
  definition: {
    type: 'function',
    function: {
      name: 'example',
      description: 'Describe the bounded operation clearly.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 200 } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  execute: async ({ text }, signal) => {
    signal.throwIfAborted()
    return { length: String(text).length }
  },
})
```

New names are disabled until explicitly selected in Settings. Return JSON-serializable data; never return functions, HTML to execute, credentials, or privileged instructions. Static definitions are listed automatically by the settings UI.

## Backend support

- **llama.cpp / GGUF:** requires Jinja (already present in HF Runner's default command), a tool-trained model and matching template, and a server version exposing `chat_template_caps.supports_tool_calls: true` in `/props`. The interface must return indexed OpenAI streaming tool-call deltas and `finish_reason: tool_calls`. Missing metadata is unsupported, even if an older server might technically work; update the runtime/template rather than bypassing detection.
- **Transformers / safetensors:** text models only for tool mode. Requires a tokenizer-owned `response_template` describing tool output, a tools-aware chat template, and the `parse_response(response, prefix=..., tools=...)` API. These APIs are not available in every Transformers version/tokenizer. The adapter preserves tool IDs and typed arguments through templates, retains special protocol tokens for parsing, and streams only parsed content/reasoning. Partial parser errors are withheld until parseable; calls are emitted once at turn completion. No Qwen/Llama/DeepSeek-specific regex protocol is hardcoded. `/props` advertises this conservative capability.
- Ordinary chat, existing thinking controls and vision continue through their existing paths when tools are disabled. Transformers tool+vision is explicitly unsupported. Tool conversations exceeding its input budget fail clearly instead of truncating call/result pairs. User-supplied OpenAI `tool_choice` constraints beyond the desktop's automatic mode are not implemented by the Python adapter.
- Template support is necessary, not proof of a model's reliability. A supported model may answer without calling a tool. Use the demo to verify a particular model/template combination.

References for the tokenizer-owned API: [Transformers tokenizer implementation](https://github.com/huggingface/transformers/blob/main/src/transformers/tokenization_utils_base.py) (`parse_response`, `get_response_parser`, `response_template`). This adapter uses `parse_response` snapshots and never falls back to text pattern matching.

## Demonstration and validation

This foundation branch ships an empty registry. Extension branches register actual tools; enable those in Settings → Tool calling and inspect their arguments/results in the chat activity. Legacy calculator preferences are discarded when loading/updating settings. The former calculator demo is removed from the application. Arithmetic handlers exist only as automated test fixtures.

Tests cover registry/schema behavior, unknown/disabled tools, handler failures, output size, timeouts, cancellation, interleaved deltas, multiple calls, round limits, truncated streams, normal chat with tools disabled, capability rejection, persisted opt-in settings, reasoning/context preservation, and an actual loopback HTTP calculator round trip. `tests/tool-python.test.ts` runs six standard-library Python tests without torch/models; Python 3 must be installed to run the full suite.

Real model execution, CUDA/Vulkan behavior and native Windows interactions are not verified by these protocol tests. Manually test a compatible GGUF and tokenizer-parser-enabled safetensors model before claiming broad model support. No model weights were downloaded for this implementation.

## Web search extension

Register a separate, disabled-by-default tool with a bounded query schema and result count. Put provider credentials and allowlisted network access in the main-process integration; respect AbortSignal, timeouts and output-size limits. Treat remote snippets as untrusted tool data, retain source URLs, and never promote them into system instructions. Review any permissions separately. On `feat/web-search`, the separate [keyless search extension](WEB_SEARCH.md) registers this tool without changing the inference loop. The underlying `feat/tool-calling` branch remains independent.

## 日本語

ツール呼び出しは標準で無効です。「チャット → ツールを使用」または「設定 → ツール呼び出し」で有効にし、ツールごとのチェックボックスとラウンド数・制限時間を設定します。この基盤ブランチには実行可能なデモツールを含みません。拡張ブランチで登録したツールを使用してください。呼び出しの引数と結果は折りたたみ表示され、「停止」で生成と協調的な処理を中断できます。

実行は Electron メインプロセス内の登録済みハンドラーのみです。JSON Schema で引数を検証し、ツールの結果を権限の高い指示として扱いません。LAN クライアントに実行権限は付与せず、シェル実行、汎用ファイル操作、MCP は含みません。このブランチの検索拡張は [WEB_SEARCH.md](WEB_SEARCH.md) を参照してください。将来のツールは `createToolRegistry()` でスキーマと非同期ハンドラーを登録し、AbortSignal とサイズ制限を守ってください。

llama.cpp は Jinja、対応モデル・テンプレート、明示的な `/props` の対応情報が必要です。Transformers はテキストモデルで、tokenizer の `response_template` と `parse_response` API が必要です。対応情報がないモデルや視覚モデルのツール呼び出しは無効です。通常の文章からツール呼び出しを推測しません。バックエンドによってはパーサーが未完の出力を保持するため、表示が遅れる場合があります。モデルを使った実動作は別途確認してください。
