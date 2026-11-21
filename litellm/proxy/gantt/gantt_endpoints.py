"""fork: read-only эндпоинт `/gantt` — лента запросов для диаграммы Ганта.

Только SELECT из `LiteLLM_SpendLogs` (+ LEFT JOIN `LiteLLM_UserTable` ради имён).
Авторизация: человеческие UI-роли (не виртуальные API-ключи).
"""
from __future__ import annotations

import json
from typing import Any, Dict, Final, List

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.proxy.gantt.inflight import register as _register_inflight, registry as _inflight
from litellm.proxy.utils import PrismaClient

router: Final = APIRouter()

# импорт этого модуля в proxy_server происходит ДО создания ProxyLogging —
# реестр незавершённых запросов успевает встать в litellm.callbacks
_register_inflight()

# user_id -> display (email local-part), общий для строк и in-flight; TTL 60 с
_names_cache: Dict[str, Any] = {"ts": 0.0, "map": {}}

_ALLOWED_ROLES: Final = {
    LitellmUserRoles.PROXY_ADMIN,
    LitellmUserRoles.PROXY_ADMIN_VIEW_ONLY,
    LitellmUserRoles.INTERNAL_USER,
    LitellmUserRoles.INTERNAL_USER_VIEW_ONLY,
}

_MAX_ROWS: Final = 5000
_MAX_WINDOW_SEC: Final = 7 * 24 * 3600

_SQL_HEAD: Final = """
SELECT COALESCE(json_agg(r ORDER BY t0 DESC), '[]') AS data FROM (
  SELECT
    floor(extract(epoch FROM s."startTime") * 1000)::bigint AS t0,
    floor(extract(epoch FROM s."endTime") * 1000)::bigint AS t1,
    CASE WHEN s."completionStartTime" IS NULL THEN NULL
         ELSE floor(extract(epoch FROM s."completionStartTime") * 1000)::bigint END AS tf,
    COALESCE(s."user", '') AS u,
    COALESCE(uu.user_email, '') AS email,
    COALESCE(NULLIF(s."model", ''), '?') AS model,
    s."prompt_tokens" AS p,
    s."completion_tokens" AS c,
    COALESCE(s."status", '') AS status,
    COALESCE(s."cache_hit", '') AS cache_hit,
    COALESCE(NULLIF(vt.key_alias, ''), NULLIF(s."metadata"->'user_api_key'->>'key_alias', ''), '') AS key_alias,
    LEFT(COALESCE(s.api_key, ''), 12) AS key_short
  FROM "LiteLLM_SpendLogs" s
  LEFT JOIN "LiteLLM_UserTable" uu ON uu.user_id = s."user"
  LEFT JOIN "LiteLLM_VerificationToken" vt ON vt.token = s.api_key
"""

# отсекаем отказы до роутинга (без ключа/модели, 0 токенов) — GPU не затрагивали
_EXCLUDE_AUTH_REJECTS: Final = """
    AND NOT (COALESCE(s."status", '') = 'failure'
             AND COALESCE(s."model", '') = ''
             AND COALESCE(s."prompt_tokens", 0) + COALESCE(s."completion_tokens", 0) = 0)
"""

# window: $1 = секунд назад, $2 = лимит
_SQL_WINDOW: Final = _SQL_HEAD + """
  WHERE s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(secs => $1)
""" + _EXCLUDE_AUTH_REJECTS + """
  ORDER BY s."startTime" DESC
  LIMIT $2
) r;
"""

# range: $1,$2 = epoch-секунды (границы хранятся как UTC naive), $3 = лимит
_SQL_RANGE: Final = _SQL_HEAD + """
  WHERE s."startTime" >= (to_timestamp($1) AT TIME ZONE 'utc')
    AND s."startTime" <= (to_timestamp($2) AT TIME ZONE 'utc')
""" + _EXCLUDE_AUTH_REJECTS + """
  ORDER BY s."startTime" DESC
  LIMIT $3
) r;
"""


@router.get(
    "/gantt",
    tags=["gantt"],
    include_in_schema=False,
)
async def get_gantt_feed(
    response: Response,
    window: int = Query(default=3600, description="окно в секундах назад"),
    from_ts: int = Query(default=None, alias="from", description="epoch ms, начало периода (вместе с to)"),
    to_ts: int = Query(default=None, alias="to", description="epoch ms, конец периода (вместе с from)"),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _ALLOWED_ROLES:
        raise HTTPException(
            status_code=403,
            detail={"error": "Gantt доступен только UI-пользователям прокси"},
        )
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "БД не подключена"})

    rng = None
    if from_ts is not None or to_ts is not None:
        if from_ts is None or to_ts is None or to_ts <= from_ts:
            raise HTTPException(status_code=400, detail={"error": "from/to должны быть заданы парой и from < to"})
        if to_ts - from_ts > _MAX_WINDOW_SEC * 1000:
            from_ts = to_ts - _MAX_WINDOW_SEC * 1000
        rng = (from_ts, to_ts)
    elif window < 10 or window > _MAX_WINDOW_SEC:
        raise HTTPException(status_code=400, detail={"error": "window вне диапазона 10..604800"})

    rows: List[Dict[str, Any]] = await _load_rows(prisma_client, window, rng)
    for r in rows:
        email = r.get("email") or ""
        r["display"] = email.split("@")[0] if email else (r.get("u") or "—")
    inflight = _inflight.snapshot()
    if inflight and rows:
        # строка уже в SpendLogs — live/завершённая запись больше не нужна.
        # модель не сравниваем: SpendLogs пишет разыменованное имя деployment
        # (openai/...-uncensored), а в реестре — запрошенный алиас; привязка
        # по (u, key) + t0 с точностью мс (замерено: Δ=9 мс)
        buckets: Dict[tuple, List[int]] = {}
        for r in rows:
            buckets.setdefault((r["u"], r["key_short"]), []).append(r["t0"])
        inflight = [
            e
            for e in inflight
            if not any(
                abs(t0 - e["t0"]) <= 1500 for t0 in buckets.get((e["u"], e["key_short"]), [])
            )
        ]
    if inflight:
        names = await _user_names(prisma_client)
        for e in inflight:
            e["display"] = names.get(e["u"]) or (e["u"] or "—")
    payload: Dict[str, Any] = {
        "max_rows": _MAX_ROWS,
        "total": len(rows),
        "rows": rows,
        "inflight": inflight,
    }
    if rng:
        payload["from"], payload["to"] = rng
    else:
        payload["window"] = window
    return payload


async def _load_rows(
    client: PrismaClient, window: int, rng: "tuple[int, int] | None" = None
) -> List[Dict[str, Any]]:
    if rng:
        result = await client.db.query_raw(_SQL_RANGE, rng[0] / 1000.0, rng[1] / 1000.0, _MAX_ROWS)
    else:
        result = await client.db.query_raw(_SQL_WINDOW, window, _MAX_ROWS)
    if not result:
        return []
    data = result[0].get("data") if isinstance(result[0], dict) else result[0]
    if isinstance(data, str):
        data = json.loads(data)
    return [dict(row) for row in (data or [])]


async def _user_names(client: PrismaClient) -> Dict[str, str]:
    """user_id -> display с кэшем 60 с (таблица маленькая, опрос Gantt каждые 5 с)."""
    import time as _time

    now = _time.monotonic()
    if now - _names_cache["ts"] > 60:
        result = await client.db.query_raw(_SQL_USERS)
        data = result[0].get("data") if result and isinstance(result[0], dict) else []
        if isinstance(data, str):
            data = json.loads(data)
        _names_cache["map"] = {row["user_id"]: row["display"] for row in (data or [])}
        _names_cache["ts"] = now
    return _names_cache["map"]


_SQL_USERS: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.display), '[]') AS data FROM (
  SELECT user_id, COALESCE(split_part(user_email, '@', 1), user_id) AS display
  FROM "LiteLLM_UserTable"
  WHERE user_id IS NOT NULL AND user_id <> ''
) r;
"""


@router.get(
    "/gantt/users",
    tags=["gantt"],
    include_in_schema=False,
)
async def get_gantt_user_map(
    response: Response,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    """Read-only map user_id -> display name (email local-part) for humanized logs."""
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _ALLOWED_ROLES:
        raise HTTPException(
            status_code=403,
            detail={"error": "Gantt доступен только UI-пользователям прокси"},
        )
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "БД не подключена"})

    result = await prisma_client.db.query_raw(_SQL_USERS)
    data = result[0].get("data") if result and isinstance(result[0], dict) else []
    if isinstance(data, str):
        data = json.loads(data)
    return {"users": {row["user_id"]: row["display"] for row in (data or [])}}
