"""fork: реестр НЕзавершённых запросов для Request Gantt.

SpendLogs пишется по завершении, поэтому «живой» запрос там не виден.
CustomLogger-хуки закрывают разрыв: `async_pre_call_hook` регистрирует
запрос прямо перед отправкой на бэкенд, `async_log_success_event` /
`async_log_failure_event` снимают его (для стрима — по концу потока,
совпадая с моментом появления строки SpendLogs).

Прокси 937 — один uvicorn-worker без Redis, поэтому реестр в памяти
процесса надёжен; при рестарте сервиса очищается (окно 2–3 с).
"""
from __future__ import annotations

import asyncio
import threading
import time
import uuid
from typing import Any, Dict, Final, List, Optional, Union

from litellm.integrations.custom_logger import CustomLogger

_META_KEY: Final = "gantt_inflight_id"
_TTL_SEC: Final = 2 * 3600
# завершённые держим, пока SpendLogs не дописался (пачковый flush ~10–20 с),
# иначе на Ганте «дырка» между концом live-бара и появлением строки
_FINISHED_GRACE_SEC: Final = 180
_MAX_ENTRIES: Final = 2000


class InFlightRegistry(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._items: Dict[str, Dict[str, Any]] = {}
        self.started_at = time.time()
        # бэкенды пакетируют несколько токенов в один SSE-чанк (упаковка нестабильна),
        # поэтому живая оценка идёт по СИМВОЛАМ стрима: tokens_per_char калибруется
        # по точным completion_tokens/символы завершённых запросов (EMA).
        # Словарь по алиасам моделей: у каждого бэкенда свой токенизатор и своя
        # «плотность» токенов в символах (источников будет десятки).
        self.tokens_per_char: Dict[str, float] = {}
        # накопительные счёты процесса (с момента запуска, Redis нет)
        self.counters: Dict[str, float] = {
            "requests": 0,
            "success": 0,
            "failure": 0,
            "stream": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "prefill_peak_tok_s": 0.0,  # пик скорости префилла с момента запуска
            "gen_peak_tok_s": 0.0,  # пик скорости генерации с момента запуска
        }

    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: Dict[str, Any],
        call_type: str,
    ) -> Optional[Union[Exception, str, Dict[str, Any]]]:
        try:
            rid = uuid.uuid4().hex
            is_stream = bool(data.get("stream"))
            entry = {
                "t0": time.time(),
                "t1": None,
                "tf": None,  # время первого content-чанка (live TTFT)
                "ntok": 0,  # content-чанков получено
                "nchars": 0,  # символов (content+reasoning) — база живой оценки токенов
                "stream": is_stream,
                "u": getattr(user_api_key_dict, "user_id", None) or "",
                "token": getattr(user_api_key_dict, "token", None) or "",
                "key_alias": getattr(user_api_key_dict, "key_alias", None) or "",
                "model": str(data.get("model") or ""),
                # запрошенный алиас НЕ перезаписывается разыменованием на FIN —
                # по нему ключуется калибровка токенов/символ конкретной модели
                "alias": str(data.get("model") or ""),
                # таска запроса: /dashboard/abort отменяет её — соединение с
                # бэкендом закрывается, бэкенд (vLLM) бросает запрос при disconnect
                "task": asyncio.current_task(),
            }
            with self._lock:
                self.counters["requests"] += 1
                if is_stream:
                    self.counters["stream"] += 1
                if len(self._items) >= _MAX_ENTRIES:
                    self._prune_locked()
                    if len(self._items) >= _MAX_ENTRIES:
                        return data
                self._items[rid] = entry
            injected = False
            for key in ("metadata", "litellm_metadata"):
                meta = data.get(key)
                if isinstance(meta, dict):
                    meta[_META_KEY] = rid
                    injected = True
                    break
            if not injected:
                data["metadata"] = {_META_KEY: rid}
        except Exception:
            pass
        return data

    def _finish(self, kwargs: Any, outcome: str = "success") -> None:
        try:
            if not isinstance(kwargs, dict):
                return
            spo = kwargs.get("standard_logging_object")
            spo = spo if isinstance(spo, dict) else {}
            p_tok = spo.get("prompt_tokens")
            c_tok = spo.get("completion_tokens")
            candidates: List[Any] = [kwargs.get("metadata"), kwargs.get("litellm_metadata")]
            lp = kwargs.get("litellm_params")
            if isinstance(lp, dict):
                candidates.extend([lp.get("metadata"), lp.get("litellm_metadata")])
            for meta in candidates:
                if isinstance(meta, dict) and isinstance(meta.get(_META_KEY), str):
                    resolved: Any = None
                    if isinstance(lp, dict) and isinstance(lp.get("model"), str) and lp["model"]:
                        resolved = lp["model"]
                    else:
                        if isinstance(spo.get("model"), str) and spo["model"]:
                            resolved = spo["model"]
                    with self._lock:
                        entry = self._items.get(meta[_META_KEY])
                        if entry is not None and entry.get("t1") is None:
                            entry["t1"] = time.time()
                            # SpendLogs пишет разыменённое имя deployment'а —
                            # приводим модель записи к нему, чтобы бар сел в свою дорожку
                            if isinstance(resolved, str) and resolved:
                                entry["model"] = resolved
                        self.counters[outcome] = self.counters.get(outcome, 0) + 1
                        if isinstance(p_tok, int) and p_tok > 0:
                            self.counters["prompt_tokens"] += p_tok
                            if entry is not None:
                                entry["ptok"] = p_tok
                                if entry.get("tf"):
                                    dur = entry["tf"] - entry["t0"]
                                    if dur > 0:
                                        rate = p_tok / dur
                                        if rate > self.counters["prefill_peak_tok_s"]:
                                            self.counters["prefill_peak_tok_s"] = round(rate, 1)
                        if isinstance(c_tok, int) and c_tok > 0:
                            self.counters["completion_tokens"] += c_tok
                            if entry is not None:
                                entry["ctok"] = c_tok
                                nchars = int(entry.get("nchars", 0))
                                if nchars > 50:
                                    key = entry.get("alias") or entry.get("model") or "?"
                                    ratio = min(max(c_tok / nchars, 0.15), 1.5)
                                    prev = self.tokens_per_char.get(key, 0.3)
                                    if key not in self.tokens_per_char and len(self.tokens_per_char) >= 64:
                                        self.tokens_per_char.pop(next(iter(self.tokens_per_char)))
                                    self.tokens_per_char[key] = round(0.7 * prev + 0.3 * ratio, 4)
                            if entry is not None and entry.get("tf"):
                                gen_dur = entry["t1"] - entry["tf"]
                                if gen_dur > 0:
                                    grate = c_tok / gen_dur
                                    if grate > self.counters["gen_peak_tok_s"]:
                                        self.counters["gen_peak_tok_s"] = round(grate, 1)
                    return
        except Exception:
            pass

    @staticmethod
    def _meta_from_request(request_data: Any) -> Any:
        # model_call_details кладёт metadata в litellm_params (см. litellm_logging),
        # рядом с той же схемой, что и в success/failure kwargs
        if not isinstance(request_data, dict):
            return None
        for key in ("metadata", "litellm_metadata"):
            m = request_data.get(key)
            if isinstance(m, dict) and _META_KEY in m:
                return m
        lp = request_data.get("litellm_params")
        if isinstance(lp, dict):
            for key in ("metadata", "litellm_metadata"):
                m = lp.get(key)
                if isinstance(m, dict) and _META_KEY in m:
                    return m
        return None

    @staticmethod
    def _chunk_text_len(chunk: Any) -> int:
        # Delta в этом апстриме — подкласс dict (в wrapper'е читают delta.get("content"));
        # reasoning-модели льют токены в reasoning_content — считаем и то, и то:
        # для «модель генерит N токенов» важны оба потока
        try:
            choices = getattr(chunk, "choices", None)
            if not choices and isinstance(chunk, dict):
                choices = chunk.get("choices")
            if not choices:
                return 0
            first = choices[0]
            delta = first.get("delta") if isinstance(first, dict) else getattr(first, "delta", None)
            if delta is None:
                return 0
            if isinstance(delta, dict):
                text = (delta.get("content") or "") + (delta.get("reasoning_content") or "")
                tcs = delta.get("tool_calls")
            else:
                text = (getattr(delta, "content", None) or "") + (getattr(delta, "reasoning_content", None) or "")
                tcs = getattr(delta, "tool_calls", None)
            # tool-call'ы льются в delta.tool_calls — их токены тоже в completion_tokens
            for tc in tcs or []:
                fn = tc.get("function") if isinstance(tc, dict) else getattr(tc, "function", None)
                if fn is not None:
                    text += (fn.get("arguments") if isinstance(fn, dict) else getattr(fn, "arguments", None)) or ""
            return len(text)
        except Exception:
            return 0

    def on_stream_chunk(self, request_data: Any, chunk: Any) -> None:
        # синхронный вызов из CustomStreamWrapper на КАЖДЫЙ чанк (патч форка
        # streaming_handler): TTFT + счётчик content-чанков ≈ живые токены
        try:
            meta = self._meta_from_request(request_data)
            if not isinstance(meta, dict):
                return
            rid = meta.get(_META_KEY)
            if not isinstance(rid, str):
                return
            text_len = self._chunk_text_len(chunk)
            with self._lock:
                entry = self._items.get(rid)
                if entry is not None and entry.get("t1") is None:
                    if entry.get("tf") is None and text_len > 0:
                        entry["tf"] = time.time()
                    if text_len > 0:
                        entry["ntok"] = int(entry.get("ntok", 0)) + 1
                        entry["nchars"] = int(entry.get("nchars", 0)) + text_len
        except Exception:
            pass

    async def async_post_call_streaming_deployment_hook(
        self,
        request_data: dict,
        response_chunk: Any,
        call_type: Any,
    ) -> Any:
        # в этой версии апстрима вызывается только на ПОСЛЕДНИМ чанке
        # (per-chunk считает on_stream_chunk); оставлен как страховка для
        # путей, не проходящих через __anext__
        try:
            meta = self._meta_from_request(request_data)
            if not isinstance(meta, dict):
                return None
            rid = meta.get(_META_KEY)
            if not isinstance(rid, str):
                return None
            text_len = self._chunk_text_len(response_chunk)
            with self._lock:
                entry = self._items.get(rid)
                if entry is not None and entry.get("t1") is None:
                    if entry.get("tf") is None and text_len > 0:
                        entry["tf"] = time.time()
                    if text_len > 0:
                        entry["ntok"] = int(entry.get("ntok", 0)) + 1
                        entry["nchars"] = int(entry.get("nchars", 0)) + text_len
        except Exception:
            pass
        return None

    async def async_log_success_event(
        self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        self._finish(kwargs, "success")

    async def async_log_failure_event(
        self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        self._finish(kwargs, "failure")

    async def async_log_stream_event(
        self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any
    ) -> None:
        # стримы без собранного ответа идут сюда, а не в success — иначе бар зависнет live
        self._finish(kwargs, "success")

    def snapshot(self) -> List[Dict[str, Any]]:
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            return [
                {
                    "id": rid,
                    "t0": int(e["t0"] * 1000),
                    "t1": int(e["t1"] * 1000) if e.get("t1") else None,
                    "tf": int(e["tf"] * 1000) if e.get("tf") else None,
                    "ptok": int(e.get("ptok", 0)),
                    "ctok": int(e.get("ctok", 0)),
                    "ntok": int(e.get("ntok", 0)),
                    "nchars": int(e.get("nchars", 0)),
                    "stream": bool(e.get("stream")),
                    "u": e["u"],
                    "key_alias": e["key_alias"],
                    "key_short": e["token"][:12],
                    "model": e["model"],
                    "alias": e.get("alias", ""),
                    "aborted": bool(e.get("aborted")),
                }
                for rid, e in self._items.items()
            ]

    def abort(self, ids: Optional[List[str]] = None) -> int:
        """Прервать live-запросы: отменить их таски (клиент получит обрыв,
        бэкенд — disconnect и сам бросит генерацию). ids=None — все live.
        Возвращает число помеченных записей."""
        wanted = set(ids) if ids is not None else None
        targets: List[Any] = []
        with self._lock:
            for rid, e in self._items.items():
                if e.get("t1") is not None:
                    continue
                if wanted is not None and rid not in wanted:
                    continue
                e["t1"] = time.time()
                e["aborted"] = True
                targets.append(e.get("task"))
            self.counters["failure"] = self.counters.get("failure", 0) + len(targets)
        n = 0
        for task in targets:
            try:
                if task is not None and not task.done():
                    task.cancel()
                    n += 1
            except Exception:
                pass
        return n

    def counters_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "uptime_sec": int(time.time() - self.started_at),
                "tokens_per_char": dict(self.tokens_per_char),
                **self.counters,
            }

    def _prune_locked(self, now: Optional[float] = None) -> None:
        now = now if now is not None else time.time()
        dead = [
            rid
            for rid, e in self._items.items()
            if (e.get("t1") and now - e["t1"] > _FINISHED_GRACE_SEC)
            or (not e.get("t1") and now - e["t0"] > _TTL_SEC)
        ]
        for rid in dead:
            del self._items[rid]
        if len(self._items) >= _MAX_ENTRIES:
            done = sorted(
                ((rid, e["t1"]) for rid, e in self._items.items() if e.get("t1")),
                key=lambda x: x[1],
            )
            for rid, _ in done[: max(len(done) - _MAX_ENTRIES // 2, 0)]:
                del self._items[rid]


registry: Final = InFlightRegistry()


def register() -> None:
    """Подключить реестр к глобальным callback'ам (вызывается при импорте роутера)."""
    import litellm

    if not any(isinstance(cb, InFlightRegistry) for cb in litellm.callbacks):
        litellm.callbacks.append(registry)
