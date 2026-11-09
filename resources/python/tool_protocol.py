"""Tokenizer-owned tool protocols only: no model-specific text/regex tool detection."""
import json
import uuid


def supports_tools(tokenizer, vision=False):
    if vision or not callable(getattr(tokenizer, "parse_response", None)):
        return False
    schema = getattr(tokenizer, "response_template", None)
    template = getattr(tokenizer, "chat_template", None)
    return bool(schema and template and "tool" in json.dumps(schema).lower() and "tools" in str(template))


def template_message(message):
    result = {"role": message["role"], "content": message["content"]}
    if message.get("reasoning_content"):
        result["reasoning_content"] = message["reasoning_content"]
    if message.get("tool_call_id"):
        result["tool_call_id"] = message["tool_call_id"]
    if message.get("tool_calls"):
        calls = []
        for call in message["tool_calls"]:
            fn = call["function"]
            arguments = fn["arguments"]
            if isinstance(arguments, str):
                arguments = json.loads(arguments)
            calls.append({**call, "function": {**fn, "arguments": arguments}})
        result["tool_calls"] = calls
    return result


def parse_message(tokenizer, text, prefix, tools):
    message = tokenizer.parse_response(text, prefix=prefix, tools=tools)
    if not isinstance(message, dict) or message.get("role", "assistant") != "assistant":
        raise ValueError("Tokenizer did not return an assistant message")
    calls = []
    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, list) or len(raw_calls) > 16:
        raise ValueError("Too many or invalid tool calls")
    for call in raw_calls:
        fn = call.get("function", {})
        if call.get("type", "function") != "function" or not isinstance(fn.get("name"), str):
            raise ValueError("Tokenizer returned an invalid tool call")
        arguments = fn.get("arguments", {})
        if isinstance(arguments, str):
            json.loads(arguments)
        else:
            arguments = json.dumps(arguments, ensure_ascii=False)
        calls.append({"id": call.get("id") or "call_" + uuid.uuid4().hex, "type": "function", "function": {"name": fn["name"], "arguments": arguments}})
    content = message.get("content") or ""
    reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
    if not isinstance(content, str) or not isinstance(reasoning, str):
        raise ValueError("Tokenizer returned invalid content")
    return {"role": "assistant", "content": content, "reasoning_content": reasoning, **({"tool_calls": calls} if calls else {})}


class ParsedStream:
    """Publish only stable parsed text prefixes; calls are emitted once the turn finishes."""
    def __init__(self, tokenizer, prefix, tools, emit):
        self.tokenizer, self.prefix, self.tools, self.emit = tokenizer, prefix, tools, emit
        self.raw = ""
        self.sent = {"content": "", "reasoning_content": ""}

    def feed(self, piece):
        self.raw += piece
        if len(self.raw) > 4 * 1024 * 1024:
            raise ValueError("Structured response exceeds 4 MiB")
        try:
            message = parse_message(self.tokenizer, self.raw, self.prefix, self.tools)
        except (ValueError, TypeError, KeyError):
            return  # A partial structured argument/message may not be parseable yet.
        self.publish(message)

    def publish(self, message):
        for field in self.sent:
            value = message.get(field) or ""
            if not value.startswith(self.sent[field]):
                raise ValueError("Tokenizer parser revised already streamed content")
            delta = value[len(self.sent[field]):]
            if delta:
                self.emit({field: delta})
                self.sent[field] = value

    def finish(self):
        message = parse_message(self.tokenizer, self.raw, self.prefix, self.tools)
        self.publish(message)
        if message.get("tool_calls"):
            self.emit({"tool_calls": [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]})
        return message
