from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import time
from typing import Any, Iterator

import requests


class LLMError(RuntimeError):
    """Raised when LLM request fails."""


@dataclass(frozen=True)
class LLMConfig:
    base_url: str
    api_key: str
    model: str
    timeout_seconds: int = 500
    proxy_url: str = ""
    max_retries: int = 2
    debug_stream: bool = False


logger = logging.getLogger(__name__)


class MiniMaxChatClient:
    def __init__(self, config: LLMConfig) -> None:
        self.config = config
        self.session = requests.Session()
        # Use only the proxy explicitly configured for this app.
        self.session.trust_env = False
        if self.config.proxy_url:
            self.session.proxies.update(
                {
                    "http": self.config.proxy_url,
                    "https": self.config.proxy_url,
                }
            )

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.3) -> str:
        response = self._request(messages=messages, temperature=temperature, stream=False)

        if response.status_code >= 400:
            raise LLMError(f"LLM request failed ({response.status_code}): {response.text}")

        data = response.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content")
        if not content:
            raise LLMError("LLM returned empty content.")
        return content

    def stream_chat(
        self, messages: list[dict[str, str]], temperature: float = 0.3
    ) -> Iterator[dict[str, str]]:
        response = self._request(messages=messages, temperature=temperature, stream=True)
        if response.status_code >= 400:
            raise LLMError(f"LLM request failed ({response.status_code}): {response.text}")

        started = time.perf_counter()
        tag_state = {"in_think": False, "pending": ""}
        if self.config.debug_stream:
            logger.info("LLM stream started status=%s", response.status_code)

        # Use tiny chunk_size to reduce buffering and improve token-level streaming feel.
        for raw_line in response.iter_lines(chunk_size=1, decode_unicode=True):
            if not raw_line:
                continue
            line = raw_line.strip()
            data_text = line[5:].strip() if line.startswith("data:") else line
            if data_text == "[DONE]":
                if self.config.debug_stream:
                    elapsed = time.perf_counter() - started
                    logger.info("LLM stream done elapsed=%.3fs", elapsed)
                break

            try:
                data = json.loads(data_text)
            except json.JSONDecodeError:
                if self.config.debug_stream:
                    elapsed = time.perf_counter() - started
                    snippet = data_text[:100].replace("\n", " ")
                    logger.info("LLM stream non-json chunk t=%.3fs text=%s", elapsed, snippet)
                continue

            choice = (data.get("choices") or [{}])[0]
            delta = choice.get("delta", {}) or {}

            thinking = delta.get("reasoning_content") or delta.get("reasoning") or ""
            if isinstance(thinking, str) and thinking:
                if self.config.debug_stream:
                    elapsed = time.perf_counter() - started
                    snippet = thinking[:100].replace("\n", " ")
                    logger.info("LLM stream thinking t=%.3fs len=%s text=%s", elapsed, len(thinking), snippet)
                yield {"type": "thinking", "text": thinking}

            content = delta.get("content")
            if isinstance(content, str) and content:
                for item in self._extract_stream_parts(content, tag_state):
                    if self.config.debug_stream:
                        elapsed = time.perf_counter() - started
                        snippet = item["text"][:100].replace("\n", " ")
                        logger.info(
                            "LLM stream %s t=%.3fs len=%s text=%s",
                            item["type"],
                            elapsed,
                            len(item["text"]),
                            snippet,
                        )
                    yield item

            # Some providers may return full message content in stream chunks.
            message_content = (choice.get("message") or {}).get("content")
            if isinstance(message_content, str) and message_content:
                for item in self._extract_stream_parts(message_content, tag_state):
                    if self.config.debug_stream:
                        elapsed = time.perf_counter() - started
                        snippet = item["text"][:100].replace("\n", " ")
                        logger.info(
                            "LLM stream message-%s t=%.3fs len=%s text=%s",
                            item["type"],
                            elapsed,
                            len(item["text"]),
                            snippet,
                        )
                    yield item

        # Flush any residual buffered text after stream ends.
        if tag_state["pending"]:
            final_type = "thinking" if tag_state["in_think"] else "content"
            yield {"type": final_type, "text": tag_state["pending"]}
            tag_state["pending"] = ""

    def _request(self, messages: list[dict[str, str]], temperature: float, stream: bool) -> requests.Response:
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json",
            # Some OpenAI-compatible providers (e.g., NVIDIA) rely on this for SSE streaming.
            "Accept": "text/event-stream" if stream else "application/json",
        }
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }

        attempts = self.config.max_retries + 1
        last_error: requests.RequestException | None = None

        for attempt in range(1, attempts + 1):
            try:
                return self.session.post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=self.config.timeout_seconds,
                    stream=stream,
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt >= attempts:
                    break
                # Lightweight backoff for unstable proxy/network hops.
                time.sleep(1.2 * attempt)

        raise LLMError(f"LLM network error: {last_error}")

    def _extract_stream_parts(self, chunk: str, state: dict[str, Any]) -> list[dict[str, str]]:
        open_tag = "<think>"
        close_tag = "</think>"
        carry_len = max(len(open_tag), len(close_tag)) - 1
        out: list[dict[str, str]] = []

        state["pending"] += chunk
        pending = state["pending"]

        while True:
            if state["in_think"]:
                end = pending.find(close_tag)
                if end == -1:
                    if len(pending) > carry_len:
                        emit = pending[:-carry_len]
                        if emit:
                            out.append({"type": "thinking", "text": emit})
                        pending = pending[-carry_len:]
                    break
                emit = pending[:end]
                if emit:
                    out.append({"type": "thinking", "text": emit})
                pending = pending[end + len(close_tag) :]
                state["in_think"] = False
                continue

            start = pending.find(open_tag)
            if start == -1:
                if len(pending) > carry_len:
                    emit = pending[:-carry_len]
                    if emit:
                        out.append({"type": "content", "text": emit})
                    pending = pending[-carry_len:]
                break

            emit = pending[:start]
            if emit:
                out.append({"type": "content", "text": emit})
            pending = pending[start + len(open_tag) :]
            state["in_think"] = True

        state["pending"] = pending
        return out
