"""fork: эндпоинты дашборда мониторинга: read-only `/dashboard/state`
и действие `/dashboard/abort` (прерывание live-запросов кнопкой).

Источник данных — ТОЛЬКО процесс LiteLLM-прокси (рамка пользователя 06.10.2026):
in-flight реестр (`proxy/gantt/inflight.py`), его накопительные счёты, состояние
роутера (модели/deployment'ы/кулдауны) и короткий SELECT из SpendLogs для истории.
Никаких внешних опросов: ни Prometheus, ни /metrics бэкендов.
Авторизация: человеческие UI-роли (как `/gantt`).
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, Final, List

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response

from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.proxy.gantt.gantt_endpoints import _ALLOWED_ROLES, _user_names
from litellm.proxy.gantt.inflight import registry as _inflight

router: Final = APIRouter()

# дашборд чувствителен (IP, User-Agent, ключи, все юзеры) — только админы;
# /gantt остаётся на общем наборе (_ALLOWED_ROLES) с internal-юзерами
_DASHBOARD_ALLOWED_ROLES: Final = {
    LitellmUserRoles.PROXY_ADMIN,
    LitellmUserRoles.PROXY_ADMIN_VIEW_ONLY,
}

_RECENT_WINDOW_SEC: Final = 3600
_RECENT_LIMIT: Final = 200

_SQL_RECENT: Final = """
SELECT COALESCE(json_agg(r ORDER BY t0 DESC), '[]') AS data FROM (
  SELECT
    floor(extract(epoch FROM s."startTime") * 1000)::bigint AS t0,
    floor(extract(epoch FROM s."endTime") * 1000)::bigint AS t1,
    CASE WHEN s."completionStartTime" IS NULL THEN NULL
         ELSE floor(extract(epoch FROM s."completionStartTime") * 1000)::bigint END AS tf,
    COALESCE(s."user", '') AS u,
    COALESCE(uu.user_email, '') AS email,
    -- показываем РЕАЛЬНУЮ модель (s.model = разыменованный deployment), алиас —
    -- отдельным полем (model_group = запрошенный алиас) для tooltip/кулдаунов
    COALESCE(NULLIF(s."model", ''), NULLIF(s."model_group", ''), '?') AS model,
    COALESCE(s."model_group", '') AS alias,
    COALESCE(s."requester_ip_address", '') AS ip,
    -- UA пишет роут в request_tags ("User-Agent: ...") — metadata.user_agent пуст
    COALESCE((SELECT string_agg(replace(t, 'User-Agent: ', ''), ' ')
              FROM jsonb_array_elements_text(COALESCE(s."request_tags", '[]')::jsonb) t), '') AS agent,
    s."prompt_tokens" AS p,
    s."completion_tokens" AS c,
    COALESCE(s."status", '') AS status,
    LEFT(COALESCE(s.api_key, ''), 12) AS key_short,
    COALESCE(vt."key_alias", '') AS key_alias
  FROM "LiteLLM_SpendLogs" s
  LEFT JOIN "LiteLLM_UserTable" uu ON uu.user_id = s."user"
  LEFT JOIN "LiteLLM_VerificationToken" vt ON vt."token" = s."api_key"
  WHERE s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(secs => $1)
    AND NOT (COALESCE(s."status", '') = 'failure'
             AND COALESCE(s."model", '') = ''
             AND COALESCE(s."prompt_tokens", 0) + COALESCE(s."completion_tokens", 0) = 0)
  ORDER BY s."startTime" DESC
  LIMIT $2
) r;
"""


def _tok_s(t_start_ms: int, t_end_ms: int, tokens: int, min_dur: float = 0.5) -> float:
    dur = (t_end_ms - t_start_ms) / 1000.0
    if tokens > 0 and dur > min_dur:
        return round(tokens / dur, 1)
    return 0.0


_PREFILL_WINDOW_SEC: Final = 3600
_PREFILL_BUCKETS: Final = 300
_PREFILL_BUCKET_SEC: Final = _PREFILL_WINDOW_SEC // _PREFILL_BUCKETS  # 12 с


def _prefill_series(items: List[Dict[str, Any]], now_ms: int) -> List[float]:
    # префилл = окно t0→первый токен; скорость = prompt_tokens / длительность окна,
    # значение относится ко всем ячейкам окна (это была непрерывная работа GPU);
    # 300 ячеек по 12 с = 60 минут
    buckets = [0.0] * _PREFILL_BUCKETS
    now_b = now_ms // 1000 // _PREFILL_BUCKET_SEC
    for it in items:
        p = int(it.get("p") or it.get("ptok") or 0)
        t0 = it.get("t0")
        tf = it.get("tf")
        if p <= 0 or not t0 or not tf or tf <= t0:
            continue
        dur_s = (tf - t0) / 1000.0
        if dur_s <= 0:
            continue
        rate = p / dur_s
        # ячейки по АБСОЛЮТНОму времени: содержимое бакета не скользит вместе с
        # «сейчас» — график и максимум стабильны между опросами, меняются только
        # когда запрос завершился (дописался в SpendLogs) или выпал из окна
        b_end = int(tf) // 1000 // _PREFILL_BUCKET_SEC
        b_start = int(t0) // 1000 // _PREFILL_BUCKET_SEC
        for b in range(b_start, b_end + 1):
            i = now_b - b
            if 0 <= i < _PREFILL_BUCKETS:
                buckets[i] += rate
    # index 0 = самая свежая ячейка → разворачиваем: график растёт слева направо,
    # как у исходящих
    return [round(x, 1) for x in reversed(buckets)]


def _resolved_map() -> Dict[str, str]:
    """алиас → разыменованная модель deployment'а (по model_list роутера).

    Нужен для live-запросов: реестр знает только запрошенный алиас, а
    пользователь хочет видеть РЕАЛЬНУЮ модель. У нас на алиас один deployment —
    резолв точный; при нескольких берётся первый.
    """
    from litellm.proxy.proxy_server import llm_router

    out: Dict[str, str] = {}
    try:
        for d in llm_router.model_list or []:
            name = str(d.get("model_name") or "")
            mp = str((d.get("litellm_params") or {}).get("model") or "")
            if name and mp and name not in out:
                out[name] = mp.split("/", 1)[1] if "/" in mp else mp
    except Exception:
        pass
    return out


def _gen_series(items: List[Dict[str, Any]], live: List[Dict[str, Any]], now_ms: int) -> List[float]:
    """Ряд исходящей генерации за 60 мин (300 ячеек × 12 с, абсолютные ячейки):
    завершённые стримы дают completion_tokens / (первый токен → конец) на своё окно,
    живые — текущую оценку tok_s от первого чанка до «сейчас»."""
    buckets = [0.0] * _PREFILL_BUCKETS
    now_b = now_ms // 1000 // _PREFILL_BUCKET_SEC
    for it in items:
        c = int(it.get("c") or 0)
        tf = it.get("tf")
        t1 = it.get("t1")
        if c <= 0 or not tf or not t1 or t1 <= tf:
            continue
        dur_s = (t1 - tf) / 1000.0
        if dur_s < 0.5:  # tf≈t1 (кэш/мгновенный ответ) дал бы миллионы ток/с
            continue
        rate = c / dur_s
        for b in range(int(tf) // 1000 // _PREFILL_BUCKET_SEC, int(t1) // 1000 // _PREFILL_BUCKET_SEC + 1):
            i = now_b - b
            if 0 <= i < _PREFILL_BUCKETS:
                buckets[i] += rate
    for e in live:
        if e["stream"] and e["tf"] and e.get("tok_s"):
            for b in range(int(e["tf"]) // 1000 // _PREFILL_BUCKET_SEC, now_b + 1):
                i = now_b - b
                if 0 <= i < _PREFILL_BUCKETS:
                    buckets[i] += e["tok_s"]
    return [round(x, 1) for x in reversed(buckets)]


def _models_state() -> List[Dict[str, Any]]:
    """Алиасы моделей и состояние их deployment'ов глазами роутера."""
    from litellm.proxy.proxy_server import llm_router

    if llm_router is None:
        return []
    out: List[Dict[str, Any]] = []
    try:
        names = llm_router.get_model_names()
    except Exception:
        return []
    for name in names:
        deps = [d for d in (llm_router.model_list or []) if d.get("model_name") == name]
        dep_ids = [str(d.get("litellm_params", {}).get("model_id") or "") for d in deps]
        dep_ids = [x for x in dep_ids if x]
        cooldown_sec = 0.0
        try:
            # get_min_cooldown возвращает default_cooldown_time (5 с), когда кулдаунов
            # НЕТ (`or self.default_cooldown_time`) — брали бы 5 у всех моделей.
            # Берём только реально активные записи, остаток = ts + cooldown_time - now.
            now_ts = time.time()
            for _, val in llm_router.cooldown_cache.get_active_cooldowns(dep_ids, None):
                rem = float(val["timestamp"]) + float(val["cooldown_time"]) - now_ts
                if rem > cooldown_sec:
                    cooldown_sec = rem
        except Exception:
            pass
        max_input = None
        for d in deps:
            try:
                dep = llm_router.get_deployment(str(d.get("litellm_params", {}).get("model_id") or ""))
                mi = getattr(dep, "model_info", None) if dep else None
                mit = getattr(mi, "max_input_tokens", None) if mi else None
                if isinstance(mit, (int, float)) and mit > 0:
                    max_input = int(mit)
                    break
            except Exception:
                pass
        out.append(
            {
                "name": name,
                "deployments": len(deps),
                "max_input_tokens": max_input,
                "cooldown_sec": round(cooldown_sec, 1),
                "state": "cooldown" if cooldown_sec > 0 else "ok",
            }
        )
    return out


@router.get(
    "/dashboard/state",
    tags=["dashboard"],
    include_in_schema=False,
)
async def get_dashboard_state(
    response: Response,
    recent: int = Query(default=_RECENT_LIMIT, description="строк истории в ответе"),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _DASHBOARD_ALLOWED_ROLES:
        raise HTTPException(
            status_code=403,
            detail={"error": "Дашборд доступен только администраторам прокси"},
        )

    now_ms = int(time.time() * 1000)
    snap = _inflight.snapshot()
    live = [e for e in snap if e["t1"] is None]
    finished = [e for e in snap if e["t1"] is not None]

    # чанки/символы ≠ токены: упаковка чанков у бэкенда нестабильна, поэтому
    # живая оценка = символы стрима × калиброванный tokens_per_char (EMA по
    # точным completion_tokens завершённых запросов, словарь по алиасам моделей)
    tpc_map: Dict[str, float] = {}
    try:
        raw = _inflight.counters_snapshot().get("tokens_per_char") or {}
        if isinstance(raw, dict):
            tpc_map = {str(k): float(v) for k, v in raw.items()}
    except Exception:
        pass

    def _tpc(e: Dict[str, Any]) -> float:
        return tpc_map.get(e.get("alias") or e.get("model") or "", 0.3)

    rmap = _resolved_map()
    for e in live:
        # live-запрос знает только алиас — подставляем реальную модель deployment'а
        e["alias"] = e.get("alias") or e["model"]
        e["model"] = rmap.get(e["alias"]) or e["model"]
        base = e["tf"] if e["tf"] else e["t0"]
        est_tokens = e["nchars"] * _tpc(e)
        e["elapsed_ms"] = max(now_ms - e["t0"], 0)
        e["ttft_ms"] = (e["tf"] - e["t0"]) if e["tf"] else None
        e["tok_s"] = _tok_s(base, now_ms, est_tokens) if e["stream"] else 0.0
        e["ntok"] = round(est_tokens)

    rows: List[Dict[str, Any]] = []
    if prisma_client is not None:
        try:
            result = await prisma_client.db.query_raw(_SQL_RECENT, _RECENT_WINDOW_SEC, min(max(recent, 1), _RECENT_LIMIT))
            data = result[0].get("data") if result and isinstance(result[0], dict) else []
            if isinstance(data, str):
                data = json.loads(data)
            rows = [dict(row) for row in (data or [])]
        except Exception:
            rows = []

    # FIN-мост: завершённые, ещё не дописанные в SpendLogs (flush 10–20 с)
    if finished and rows:
        buckets: Dict[tuple, List[int]] = {}
        for r in rows:
            buckets.setdefault((r["u"], r["key_short"]), []).append(r["t0"])
        finished = [
            e
            for e in finished
            if not any(abs(t0 - e["t0"]) <= 1500 for t0 in buckets.get((e["u"], e["key_short"]), []))
        ]

    names: Dict[str, str] = {}
    if prisma_client is not None and (rows or snap):
        try:
            names = await _user_names(prisma_client)
        except Exception:
            names = {}

    def _disp(u: str, email: str = "") -> str:
        return email.split("@")[0] if email else (names.get(u) or u or "—")

    recent_rows: List[Dict[str, Any]] = []
    for r in rows:
        dur = (r["t1"] - r["t0"]) if r["t1"] and r["t0"] else None
        c = int(r.get("c") or 0)
        recent_rows.append(
            {
                "t0": r["t0"],
                "t1": r["t1"],
                "tf": r.get("tf"),
                "u": r["u"],
                "display": _disp(r["u"], r.get("email") or ""),
                "key_alias": r.get("key_alias") or "",
                "key_short": r.get("key_short") or "",
                "model": r["model"],
                "alias": r.get("alias") or "",
                "ip": r.get("ip") or "",
                "agent": r.get("agent") or "",
                "p": int(r.get("p") or 0),
                "c": c,
                "status": r["status"],
                "duration_ms": dur,
                "tok_s": _tok_s(r.get("tf") or r["t0"], r["t1"], c) if r["t1"] else 0.0,
                "prefill_tok_s": _tok_s(r["t0"], r["tf"], int(r.get("p") or 0), 0.05) if r.get("tf") else 0.0,
            }
        )
    for e in finished:
        recent_rows.append(
            {
                "t0": e["t0"],
                "t1": e["t1"],
                "tf": e["tf"],
                "u": e["u"],
                "display": _disp(e["u"]),
                "key_alias": e.get("key_alias", ""),
                "key_short": e.get("key_short", ""),
                # на FIN реестр уже подменил model на разыменованный deployment
                "model": e["model"],
                "alias": e.get("alias", ""),
                # реестр in-flight IP/UA не пишет — для FIN-моста недоступно
                "ip": "",
                "agent": "",
                "p": e.get("ptok", 0),
                "c": e.get("ctok") or (round(e["nchars"] * _tpc(e)) if e["stream"] else 0),
                "status": "success",
                "duration_ms": (e["t1"] - e["t0"]) if e["t1"] else None,
                "tok_s": _tok_s(e["tf"] or e["t0"], e["t1"], e.get("ctok") or 0) if e["t1"] and e["stream"] else 0.0,
                "prefill_tok_s": _tok_s(e["t0"], e["tf"], e.get("ptok", 0), 0.05) if e["tf"] else 0.0,
            }
        )
    recent_rows.sort(key=lambda x: x["t0"], reverse=True)
    recent_rows = recent_rows[: min(max(recent, 1), _RECENT_LIMIT)]

    for e in live:
        e["display"] = _disp(e["u"])

    return {
        "now": now_ms,
        "counters": _inflight.counters_snapshot(),
        "state": "generating" if live else "idle",
        "inflight": live,
        "recent": recent_rows,
        "models": _models_state(),
        "prefill": {
            "window_sec": _PREFILL_WINDOW_SEC,
            "series": _prefill_series(recent_rows, now_ms),
        },
        "gen": {
            "window_sec": _PREFILL_WINDOW_SEC,
            "series": _gen_series(recent_rows, live, now_ms),
        },
    }


@router.post(
    "/dashboard/abort",
    tags=["dashboard"],
    include_in_schema=False,
)
async def post_dashboard_abort(
    payload: Dict[str, Any] = Body(default_factory=dict),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    """Прервать live-запросы: {"ids": [...]} — конкретные (id из inflight),
    {"all": true} — все. Отмена таски закрывает соединение до бэкенда."""
    if user_api_key_dict.user_role not in _DASHBOARD_ALLOWED_ROLES:
        raise HTTPException(
            status_code=403,
            detail={"error": "Дашборд доступен только администраторам прокси"},
        )
    ids = payload.get("ids")
    if ids is not None and (
        not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HTTPException(status_code=422, detail={"error": "ids — список строк"})
    aborted = _inflight.abort(None if payload.get("all") else ids)
    return {"aborted": aborted}
