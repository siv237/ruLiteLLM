"""fork: эндпоинты `/dashboard/journal/*` — панель «Журнал активности» (v1, 08.10.2026).

Двухслойная панель по PLAN-срезы-активности.md:
  слой 1 — журнал: тепловая карта дни×часы, синтетический список участников,
    страница участника — чистый SQL по SpendLogs, без LLM;
  слой 2 — оценка: ручной запуск «оценить период» (дайджест → один запрос к выбранной
    модели через собственный гейт), история оценок в таблице `LiteLLM_DGK_ActivitySnapshots`.

Рамка: только то, что знает LiteLLM (LiteLLM_SpendLogs + справочники). Тексты запросов
(proxy_server_request) пишутся с 06.10.2026 — более ранние периоды статистические.
TZ: startTime хранится naive-UTC; витрина — Asia/Vladivostok
(`AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Vladivostok'`, см. wiki/answers/litellm-request-content-analysis.md).
Авторизация: только админы (как /dashboard/state).
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from datetime import datetime
from typing import Any, Dict, Final, List, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.proxy.gantt.gantt_endpoints import _user_names

router: Final = APIRouter()

_TZ: Final = "Asia/Vladivostok"

_JOURNAL_ALLOWED_ROLES: Final = {
    LitellmUserRoles.PROXY_ADMIN,
    LitellmUserRoles.PROXY_ADMIN_VIEW_ONLY,
}

_MAX_DAYS: Final = 92
_EVAL_MAX_DAYS: Final = 7
_RECENT_LIMIT: Final = 500

# «живой» интерактивный клиент vs скрипт/система (UA из request_tags)
_INTERACTIVE_RE: Final = "kilo|opencode|claude[- _]?code|cursor|cline|jetbrains|copilot"

# мусорные pseudo-сессии в первых репликах (см. страницу-анализ); _EVAL_USER — собственные оценки журнала
_EVAL_USER: Final = "journal-eval"
_TXT_FILTER: Final = """txt NOT ILIKE '%Generate a title%'
    AND txt NOT LIKE '%kilo-memory-evidence-v1%' AND txt NOT ILIKE '%consolidation%'
    AND txt NOT LIKE '%внутреннего гейтвея%'"""

# оконный CTE: витрина + фильтры; {win} — оконное условие, дальше {filt} — model/agent/key
_W_CTE: Final = """
WITH w AS (
  SELECT
    (s."startTime" AT TIME ZONE 'UTC' AT TIME ZONE '{tz}') AS lt,
    COALESCE(s."user", '') AS u,
    COALESCE(s.session_id, '') AS sid,
    COALESCE(s.total_tokens, 0) AS tok,
    COALESCE(NULLIF(s."model_group", ''), NULLIF(s."model", ''), '?') AS m,
    COALESCE((SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(COALESCE(s."request_tags", '[]')::jsonb) t), '') AS tags,
    COALESCE(vt."key_alias", '') AS ka
  FROM "LiteLLM_SpendLogs" s
  LEFT JOIN "LiteLLM_VerificationToken" vt ON vt."token" = s."api_key"
  WHERE {win}
    AND NOT (COALESCE(s."status", '') = 'failure' AND COALESCE(s."model", '') = ''
             AND COALESCE(s."prompt_tokens", 0) + COALESCE(s."completion_tokens", 0) = 0)
)
"""


def _win_clause(col: str, days: int, dt_from: str = "", dt_to: str = "") -> Tuple[str, List[Any], int]:
    """Окно выборки: абсолютное локальное [from,to) (Владивосток) либо относительное «последние days суток».
    Возвращает (условие WHERE, параметры, номер следующего параметра)."""
    if dt_from and dt_to:
        win = (
            f"{col} >= ($1::timestamp AT TIME ZONE '{_TZ}' AT TIME ZONE 'UTC')"
            f" AND {col} < ($2::timestamp AT TIME ZONE '{_TZ}' AT TIME ZONE 'UTC')"
        )
        return win, [dt_from, dt_to], 3
    return f"{col} >= (now() AT TIME ZONE 'utc') - make_interval(days => $1::int)", [days], 2


_WIN_S_REL: Final = """s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => $1::int)"""
_WIN_REL: Final = """"startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => $1::int)"""


def _filters(model: str, agent: str, key: str, start_param: int) -> Tuple[str, List[Any]]:
    """хвост WHERE по CTE w с динамическими параметрами, начиная с start_param."""
    conds: List[str] = []
    params: List[Any] = []
    i = start_param
    if model:
        conds.append(f"m = ${i}")
        params.append(model)
        i += 1
    if agent:
        conds.append(f"tags ILIKE '%' || ${i} || '%'")
        params.append(agent)
        i += 1
    if key:
        conds.append(f"ka ILIKE '%' || ${i} || '%'")
        params.append(key)
        i += 1
    return (("WHERE " + " AND ".join(conds)) if conds else "", params)


async def _rows(client: Any, sql: str, *args: Any) -> List[Dict[str, Any]]:
    result = await client.db.query_raw(sql, *args)
    data = result[0].get("data") if result and isinstance(result[0], dict) else []
    if isinstance(data, str):
        data = json.loads(data)
    return [dict(r) for r in (data or [])]


_SQL_CELLS: Final = (
    _W_CTE
    + """
SELECT COALESCE(json_agg(r ORDER BY r.d, r.h), '[]') AS data FROM (
  SELECT to_char(lt, 'YYYY-MM-DD') AS d, extract(hour FROM lt)::int AS h,
         count(*)::int AS n, sum(tok)::bigint AS tok,
         count(DISTINCT nullif(u, ''))::int AS ppl
  FROM w {filt} GROUP BY 1, 2
) r;
"""
)

_SQL_PREV: Final = """
SELECT COALESCE(json_agg(r), '[]') AS data FROM (
  SELECT count(*)::bigint AS reqs,
         COALESCE(sum(total_tokens), 0)::bigint AS tok,
         count(DISTINCT nullif(COALESCE("user", ''), ''))::int AS ppl
  FROM "LiteLLM_SpendLogs" s
  WHERE s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => (${p} * 2)::int)
    AND s."startTime" <  (now() AT TIME ZONE 'utc') - make_interval(days => ${p}::int)
    AND NOT (COALESCE(s."status", '') = 'failure' AND COALESCE(s."model", '') = ''
             AND COALESCE(s."prompt_tokens", 0) + COALESCE(s."completion_tokens", 0) = 0)
) r;
"""

_SQL_PARTICIPANTS: Final = (
    _W_CTE
    + """
SELECT COALESCE(json_agg(r ORDER BY r.reqs DESC), '[]') AS data FROM (
  SELECT w.u,
         count(*)::bigint AS reqs,
         sum(w.tok)::bigint AS tok,
         count(DISTINCT w.sid)::int AS sess,
         count(DISTINCT w.m)::int AS nmodels,
         (SELECT string_agg(g.m, ', ') FROM (
            SELECT m FROM w w2 WHERE w2.u = w.u GROUP BY m ORDER BY count(*) DESC LIMIT 3) g) AS models,
         bool_or(w.tags ~* '{ire}') AS interactive,
         COALESCE(uu.user_email, '') AS email,
         to_char(min(w.lt), 'YYYY-MM-DD HH24:MI') AS t_first,
         to_char(max(w.lt), 'YYYY-MM-DD HH24:MI') AS t_last,
         lpad(min(to_char(w.lt, 'HH24'))::text, 2, '0') || ':00–' || lpad(max(to_char(w.lt, 'HH24'))::text, 2, '0') || ':59' AS hours
  FROM w
  LEFT JOIN "LiteLLM_UserTable" uu ON uu.user_id = w.u
  {filt}
  GROUP BY w.u, uu.user_email
) r;
"""
)

# «обмены»: user-реплики в ПОСЛЕДНЕМ теле сессии (диалог растёт — последнее fullest)
_SQL_EXCH: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.exch DESC), '[]') AS data FROM (
  SELECT z.u, SUM((SELECT count(*) FROM jsonb_array_elements(z.psr -> 'messages') mm
                   WHERE mm ->> 'role' = 'user'))::bigint AS exch
  FROM (
    SELECT DISTINCT ON (COALESCE(s."user", ''), s.session_id)
           COALESCE(s."user", '') AS u, s.session_id AS sid, s.proxy_server_request AS psr
    FROM "LiteLLM_SpendLogs" s
    WHERE s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => ${p}::int)
      AND s.call_type = 'acompletion' AND s.proxy_server_request IS NOT NULL
    ORDER BY 1, 2, s."startTime" DESC
  ) z
  GROUP BY z.u
) r;
"""

# первая содержательная реплика сессий (метод из wiki/answers/litellm-request-content-analysis.md)
_SQL_FIRST: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.t0 DESC), '[]') AS data FROM (
  SELECT um.u, um.sid,
         to_char(um.t0, 'YYYY-MM-DD HH24:MI') AS t0,
         um.turns::int AS turns,
         left(regexp_replace(um.txt, '\\s+', ' ', 'g'), 160) AS txt
  FROM (
    SELECT DISTINCT ON (c.u, c.sid) c.u, c.sid, c.t0, c.turns, c.txt
    FROM (
      SELECT fr.u, fr.sid, fr.t0, fr.turns, e.ord,
             CASE jsonb_typeof(m -> 'content')
               WHEN 'string' THEN m ->> 'content'
               ELSE (SELECT string_agg(p ->> 'text', ' ')
                     FROM jsonb_array_elements(m -> 'content') p WHERE p ->> 'type' = 'text')
             END AS txt
      FROM (
        SELECT DISTINCT ON (COALESCE("user", ''), session_id)
               COALESCE("user", '') AS u, session_id AS sid,
               ("startTime" AT TIME ZONE 'UTC' AT TIME ZONE '{tz}') AS t0,
               count(*) OVER (PARTITION BY COALESCE("user", ''), session_id) AS turns,
               proxy_server_request AS psr
        FROM "LiteLLM_SpendLogs"
        WHERE {win}
          AND call_type = 'acompletion' AND proxy_server_request IS NOT NULL
          AND coalesce(session_id, '') <> ''
          AND COALESCE("user", '') <> '{eu}'
      ) fr,
      jsonb_array_elements(fr.psr -> 'messages') WITH ORDINALITY e(m, ord)
      WHERE m ->> 'role' = 'user'
    ) c
    WHERE coalesce(c.txt, '') !~ '^\\s*$' AND {txtf}
    ORDER BY c.u, c.sid, c.ord
  ) um
) r;
"""


def _disp(u: str, email: str, names: Dict[str, str]) -> str:
    if not u:
        return "аноним"
    if email:
        return email.split("@")[0]
    return names.get(u) or u


_SVC_EMAIL_RE: Final = re.compile(r"^(svc|service|bot|system|default_user)", re.IGNORECASE)


def _ptype(email: str, interactive: bool, u: str) -> str:
    if not u:
        return "anon"
    if email and _SVC_EMAIL_RE.match(email.split("@")[0]):
        return "system"
    if email or interactive:
        return "human"
    return "system"


@router.get("/dashboard/journal/state", tags=["journal"], include_in_schema=False)
async def get_journal_state(
    response: Response,
    days: int = Query(default=30, ge=1, le=_MAX_DAYS),
    model: str = Query(default=""),
    agent: str = Query(default=""),
    key: str = Query(default=""),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})

    filt, fparams = _filters(model, agent, key, 2)

    cells_sql = _SQL_CELLS.format(tz=_TZ, filt=filt, win=_WIN_S_REL)
    parts_sql = _SQL_PARTICIPANTS.format(tz=_TZ, filt=filt, ire=_INTERACTIVE_RE, win=_WIN_S_REL)
    exch_sql = _SQL_EXCH.replace("{p}", "1")
    first_sql = _SQL_FIRST.format(tz=_TZ, txtf=_TXT_FILTER, eu=_EVAL_USER, win=_WIN_REL)
    prev_sql = _SQL_PREV.replace("{p}", "1")

    try:
        cells = await _rows(prisma_client, cells_sql, days, *fparams)
        parts = await _rows(prisma_client, parts_sql, days, *fparams)
        exch_rows = await _rows(prisma_client, exch_sql, days)
        first = await _rows(prisma_client, first_sql, days)
        prev = (await _rows(prisma_client, prev_sql, days)) or [{}]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": f"SQL журнала: {str(e)[:400]}"}) from e

    names: Dict[str, str] = {}
    try:
        names = await _user_names(prisma_client)
    except Exception:
        pass

    exch_map = {r["u"]: int(r.get("exch") or 0) for r in exch_rows}
    participants = []
    humans = systems = 0
    for p in parts:
        t = _ptype(p.get("email") or "", bool(p.get("interactive")), p["u"])
        humans += t == "human"
        systems += t == "system"
        participants.append(
            {
                "u": p["u"],
                "display": _disp(p["u"], p.get("email") or "", names),
                "type": t,
                "reqs": int(p["reqs"]),
                "tok": int(p["tok"]),
                "sess": int(p["sess"]),
                "exch": exch_map.get(p["u"], 0),
                "hours": p.get("hours") or "",
                "models": p.get("models") or "",
                "t_first": p.get("t_first") or "",
                "t_last": p.get("t_last") or "",
            }
        )

    total_reqs = sum(int(c["n"]) for c in cells)
    total_tok = sum(int(c["tok"]) for c in cells)
    by_hour: Dict[int, int] = {}
    for c in cells:
        by_hour[c["h"]] = by_hour.get(c["h"], 0) + int(c["n"])
    peak = max(by_hour.items(), key=lambda kv: kv[1])[0] if by_hour else None

    recent = [
        {
            "u": r["u"],
            "sid": r.get("sid") or "",
            "display": _disp(r["u"], "", names),
            "t": r["t0"],
            "txt": r["txt"],
            "turns": r["turns"],
        }
        for r in first[:_RECENT_LIMIT]
    ]

    models: List[str] = []
    try:
        from litellm.proxy.proxy_server import llm_router

        models = sorted(llm_router.get_model_names()) if llm_router else []
    except Exception:
        pass

    return {
        "days": days,
        "tz": _TZ,
        "now": int(time.time() * 1000),
        "cells": cells,
        "totals": {
            "reqs": total_reqs,
            "tok": total_tok,
            "people": humans,
            "systems": systems,
            "participants": len(participants),
            "peak_hour": peak,
            "prev_reqs": int(prev[0].get("reqs") or 0),
            "prev_tok": int(prev[0].get("tok") or 0),
            "prev_people": int(prev[0].get("ppl") or 0),
        },
        "participants": participants,
        "recent": recent,
        "models": models,
    }


# полный текст первой содержательной user-реплики сессии (для модалки «последняя активность»)
_SQL_MESSAGE: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.ord), '[]') AS data FROM (
  SELECT e.ord,
         CASE jsonb_typeof(m -> 'content')
           WHEN 'string' THEN m ->> 'content'
           ELSE (SELECT string_agg(p ->> 'text', chr(10))
                 FROM jsonb_array_elements(m -> 'content') p WHERE p ->> 'type' = 'text')
         END AS txt
  FROM (
    SELECT proxy_server_request AS psr
    FROM "LiteLLM_SpendLogs"
    WHERE session_id = $1 AND call_type = 'acompletion' AND proxy_server_request IS NOT NULL
    ORDER BY "startTime" ASC
    LIMIT 1
  ) fr,
  jsonb_array_elements(fr.psr -> 'messages') WITH ORDINALITY e(m, ord)
  WHERE m ->> 'role' = 'user'
) r;
"""

_MSG_MAX_CHARS: Final = 30000


@router.get("/dashboard/journal/message", tags=["journal"], include_in_schema=False)
async def get_journal_message(
    sid: str = Query(min_length=1, max_length=200),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})

    try:
        rows = await _rows(prisma_client, _SQL_MESSAGE, sid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": f"SQL журнала: {str(e)[:400]}"}) from e

    txt = ""
    for r in rows:
        if (r.get("txt") or "").strip():
            txt = r["txt"]
            break
    return {"sid": sid, "txt": txt[:_MSG_MAX_CHARS], "chars": len(txt), "truncated": len(txt) > _MSG_MAX_CHARS}


# ---------------- страница участника ----------------

_SQL_USER_AGG: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.t0 DESC), '[]') AS data FROM (
  SELECT s.session_id AS sid,
         to_char(min((s."startTime" AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')), 'YYYY-MM-DD HH24:MI') AS t0,
         to_char(max((s."startTime" AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')), 'HH24:MI') AS t1,
         floor(extract(epoch FROM max(s."endTime") - min(s."startTime")) / 60)::int AS dur_min,
         count(*)::int AS turns,
         COALESCE(sum(s.total_tokens), 0)::bigint AS tok,
         mode() WITHIN GROUP (ORDER BY COALESCE(NULLIF(s."model_group", ''), NULLIF(s."model", ''), '?')) AS model,
         mode() WITHIN GROUP (ORDER BY COALESCE((SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(COALESCE(s."request_tags", '[]')::jsonb) t), '')) AS agent
  FROM "LiteLLM_SpendLogs" s
  WHERE COALESCE(s."user", '') = ${p}
    AND s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => ${d}::int)
    AND NOT (COALESCE(s."status", '') = 'failure' AND COALESCE(s."model", '') = ''
             AND COALESCE(s."prompt_tokens", 0) + COALESCE(s."completion_tokens", 0) = 0)
  GROUP BY s.session_id
  ORDER BY 2 DESC
  LIMIT 120
) r;
"""

_SQL_USER_DAY: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.d), '[]') AS data FROM (
  SELECT to_char((s."startTime" AT TIME ZONE 'UTC' AT TIME ZONE '{tz}'), 'YYYY-MM-DD') AS d,
         count(*)::int AS n, COALESCE(sum(s.total_tokens), 0)::bigint AS tok
  FROM "LiteLLM_SpendLogs" s
  WHERE COALESCE(s."user", '') = ${p}
    AND s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => ${d}::int)
  GROUP BY 1
) r;
"""

_SQL_USER_MODELS: Final = """
SELECT COALESCE(json_agg(r ORDER BY r.n DESC), '[]') AS data FROM (
  SELECT COALESCE(NULLIF(s."model_group", ''), NULLIF(s."model", ''), '?') AS m, count(*)::int AS n
  FROM "LiteLLM_SpendLogs" s
  WHERE COALESCE(s."user", '') = ${p}
    AND s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => ${d}::int)
  GROUP BY 1
) r;
"""

_SQL_USER_EXCH: Final = """
SELECT COALESCE(json_agg(r), '[]') AS data FROM (
  SELECT z.sid, (SELECT count(*) FROM jsonb_array_elements(z.psr -> 'messages') mm
                 WHERE mm ->> 'role' = 'user')::int AS exch
  FROM (
    SELECT DISTINCT ON (s.session_id) s.session_id AS sid, s.proxy_server_request AS psr
    FROM "LiteLLM_SpendLogs" s
    WHERE COALESCE(s."user", '') = ${p}
      AND s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => ${d}::int)
      AND s.call_type = 'acompletion' AND s.proxy_server_request IS NOT NULL
    ORDER BY 1, s."startTime" DESC
  ) z
) r;
"""

_SQL_USER_FIRST: Final = """
SELECT COALESCE(json_agg(r), '[]') AS data FROM (
  SELECT DISTINCT ON (c.sid) c.sid, left(regexp_replace(c.txt, '\\s+', ' ', 'g'), 200) AS txt
  FROM (
    SELECT fr.sid, e.ord,
           CASE jsonb_typeof(m -> 'content')
             WHEN 'string' THEN m ->> 'content'
             ELSE (SELECT string_agg(p ->> 'text', ' ')
                   FROM jsonb_array_elements(m -> 'content') p WHERE p ->> 'type' = 'text')
           END AS txt
    FROM (
      SELECT DISTINCT ON (session_id) session_id AS sid, proxy_server_request AS psr
      FROM "LiteLLM_SpendLogs"
      WHERE COALESCE("user", '') = ${p}
        AND "startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => ${d}::int)
        AND call_type = 'acompletion' AND proxy_server_request IS NOT NULL
        AND coalesce(session_id, '') <> ''
      ORDER BY 1, "startTime"
    ) fr,
    jsonb_array_elements(fr.psr -> 'messages') WITH ORDINALITY e(m, ord)
    WHERE m ->> 'role' = 'user'
  ) c
  WHERE coalesce(c.txt, '') !~ '^\\s*$' AND {txtf}
  ORDER BY c.sid, c.ord
) r;
"""


@router.get("/dashboard/journal/user", tags=["journal"], include_in_schema=False)
async def get_journal_user(
    response: Response,
    u: str = Query(..., description="user_id из SpendLogs (пустая строка = аноним)"),
    days: int = Query(default=7, ge=1, le=_MAX_DAYS),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})

    try:
        sess = await _rows(prisma_client, _SQL_USER_AGG.format(tz=_TZ, p=1, d=2), u, days)
        days_rows = await _rows(prisma_client, _SQL_USER_DAY.format(tz=_TZ, p=1, d=2), u, days)
        models_rows = await _rows(prisma_client, _SQL_USER_MODELS.format(tz=_TZ, p=1, d=2), u, days)
        exch_rows = await _rows(prisma_client, _SQL_USER_EXCH.format(tz=_TZ, p=1, d=2), u, days)
        first_rows = await _rows(prisma_client, _SQL_USER_FIRST.format(tz=_TZ, p=1, d=2, txtf=_TXT_FILTER), u, days)
        emails = await prisma_client.db.query_raw(
            'SELECT user_email FROM "LiteLLM_UserTable" WHERE user_id = $1', u
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": f"SQL журнала: {str(e)[:400]}"}) from e

    names: Dict[str, str] = {}
    try:
        names = await _user_names(prisma_client)
    except Exception:
        pass
    email = (emails[0].get("user_email") or "") if emails else ""
    exch_map = {r["sid"]: int(r.get("exch") or 0) for r in exch_rows}
    first_map = {r["sid"]: r["txt"] for r in first_rows}

    sessions = [
        {
            "sid": s["sid"],
            "t0": s["t0"],
            "t1": s["t1"],
            "dur_min": s["dur_min"],
            "turns": s["turns"],
            "exch": exch_map.get(s["sid"], 0),
            "tok": int(s["tok"]),
            "model": s["model"],
            "agent": s.get("agent") or "",
            "first": first_map.get(s["sid"], ""),
        }
        for s in sess
    ]
    total_reqs = sum(s["turns"] for s in sessions)
    total_tok = sum(s["tok"] for s in sessions)
    total_exch = sum(s["exch"] for s in sessions)
    m_total = sum(int(m["n"]) for m in models_rows) or 1
    top_models = [
        {"m": m["m"], "n": int(m["n"]), "pct": round(100 * int(m["n"]) / m_total, 1)} for m in models_rows[:6]
    ]
    longest = max(sessions, key=lambda s: s["dur_min"] or 0, default=None)
    agents: Dict[str, int] = {}
    for s in sessions:
        for tag in (s["agent"] or "").split():
            if "/" in tag or "-" in tag:
                agents[tag] = agents.get(tag, 0) + 1
    top_agent = max(agents.items(), key=lambda kv: kv[1])[0] if agents else ""

    return {
        "u": u,
        "display": _disp(u, email, names),
        "email": email,
        "days": days,
        "tz": _TZ,
        "totals": {
            "reqs": total_reqs,
            "tok": total_tok,
            "sess": len(sessions),
            "exch": total_exch,
        },
        "daily": [{"d": r["d"], "n": int(r["n"]), "tok": int(r["tok"])} for r in days_rows],
        "top_models": top_models,
        "sessions": sessions,
        "facts": {
            "longest_min": (longest or {}).get("dur_min") or 0,
            "top_agent": top_agent,
        },
    }


# ---------------- слой 2: оценка периода ----------------

_SNAP_TABLE: Final = '"LiteLLM_DGK_ActivitySnapshots"'
_table_ready: Final = {"ok": False}

_CREATE_TABLE: Final = """
CREATE TABLE IF NOT EXISTS "LiteLLM_DGK_ActivitySnapshots" (
  id serial PRIMARY KEY,
  "createdAt" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  "periodDays" int NOT NULL,
  "targetU" text NOT NULL DEFAULT '',
  "targetSid" text NOT NULL DEFAULT '',
  "periodFrom" text NOT NULL DEFAULT '',
  "periodTo" text NOT NULL DEFAULT '',
  model text NOT NULL,
  "digestChars" int NOT NULL DEFAULT 0,
  report text NOT NULL,
  "createdBy" text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT ''
);
"""

_EVAL_PROMPT: Final = """Это сводка с нашего внутреннего гейтвея LiteLLM {win}: статистика \
по сотрудникам и реальные первые реплики их сессий с ИИ. Проанализируй конкретно: ЧЕМ ИМЕННО занят \
каждый — проекты, задачи, системы из реплик. Только по данным, не выдумай. По-русски, сразу итоговый ответ \
без черновика. ОБЯЗАТЕЛЬНО отдельным разделом КАЖДЫЙ пользователь из блока СТАТИСТИКА (включая сервисные, \
default_user_id и анонимных); если текстов нет — напиши «видна только статистика». Структура ответа (markdown):

## Сводка
таблица, одной строкой на участника: | Участник | Характер | Запросов | Чем занят |
(характер: реальная работа / обучение-эксперименты / развлечения / сервисная автоматизация)

## Имя_участника
заголовок h2 на каждого; под ним строка **Характер: …** и 2–4 буллета конкретики \
(проекты, задачи, системы, тон общения — только из данных)

## Общий вывод
3–5 строк: кто чем загружен, повторы и аномалии, заметные изменения."""


@router.get("/dashboard/journal/window", tags=["journal"], include_in_schema=False)
async def get_journal_window(
    response: Response,
    days: int = Query(default=1, ge=1, le=_MAX_DAYS),
    dt_from: str = Query(default="", description="локальное начало «YYYY-MM-DD HH:MM» (Владивосток)"),
    dt_to: str = Query(default="", description="локальное конец «YYYY-MM-DD HH:MM» (Владивосток)"),
    model: str = Query(default=""),
    agent: str = Query(default=""),
    key: str = Query(default=""),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    """Быстрый анализ окна: список запросов (кто/когда/модель/токены/сессия) без LLM."""
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})
    win, params, nxt = _win_clause('s."startTime"', days, dt_from, dt_to)
    filt, fparams = _filters(model, agent, key, nxt)
    sql = (
        _W_CTE.format(tz=_TZ, win=win)
        + f"""
SELECT COALESCE(json_agg(r ORDER BY r.t DESC), '[]') AS data FROM (
  SELECT to_char(lt, 'YYYY-MM-DD HH24:MI:SS') AS t, u, sid, tok, m, tags
  FROM w {filt} LIMIT 500
) r;"""
    )
    rows = await _rows(prisma_client, sql, *params, *fparams)
    names = await _safe_names(prisma_client)
    out: List[Dict[str, Any]] = []
    summary: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        tags = r.get("tags") or ""
        kind = "system" if re.search(_INTERACTIVE_RE, tags, re.I) is None else "human"
        disp = _disp(r["u"], "", names)
        out.append({"t": r["t"], "u": r["u"], "display": disp, "kind": kind, "sid": r["sid"], "tok": r["tok"], "m": r["m"]})
        s = summary.setdefault(r["u"], {"u": r["u"], "display": disp, "kind": kind, "reqs": 0, "tok": 0, "sids": set()})
        s["reqs"] += 1
        s["tok"] += int(r["tok"] or 0)
        if r["sid"]:
            s["sids"].add(r["sid"])
    summ = sorted(
        [{"u": s["u"], "display": s["display"], "kind": s["kind"], "reqs": s["reqs"], "tok": s["tok"], "sess": len(s["sids"])} for s in summary.values()],
        key=lambda x: -x["reqs"],
    )
    return {"rows": out, "summary": summ, "truncated": len(out) >= 500}


def _build_digest(
    parts: List[Dict[str, Any]], first: List[Dict[str, Any]], names: Dict[str, str], target_u: str = ""
) -> str:
    if target_u:
        parts = [p for p in parts if p["u"] == target_u]
        first = [r for r in first if r["u"] == target_u]
    lines = ["СТАТИСТИКА за период (участник|запросов|токенов|сессий|топ-модели):"]
    for p in parts:
        disp = _disp(p["u"], p.get("email") or "", names)
        kind = " [система]" if _ptype(p.get("email") or "", bool(p.get("interactive")), p["u"]) == "system" else ""
        lines.append(f"{disp}{kind}|{p['reqs']}|{p['tok']}|{p['sess']}|{p.get('models') or ''}")
    lines.append("")
    lines.append("НАЧАЛА СЕССИЙ (участник => первая реплика [обменов]):")
    per_user: Dict[str, int] = {}
    skipped: Dict[str, int] = {}
    for r in first:
        u = r["u"]
        if per_user.get(u, 0) >= 15:
            skipped[u] = skipped.get(u, 0) + 1
            continue
        per_user[u] = per_user.get(u, 0) + 1
        disp = _disp(u, "", names)
        lines.append(f"{disp} => \"{r['txt']}\" [{r['turns']}]")
    for u, n in skipped.items():
        lines.append(f"{_disp(u, '', names)} => … ещё {n} сессий (повторы)")
    return "\n".join(lines)


async def _safe_names(client: Any) -> Dict[str, str]:
    try:
        return await _user_names(client)
    except Exception:
        return {}


# дайджест одной сессии: статистика + все user-реплики из ПОСЛЕДнего тела (полная переписка)
_SQL_SESSION_DIGEST: Final = """
WITH m AS (
  SELECT COALESCE(s."user", '') AS u, count(*)::int AS turns, COALESCE(sum(s.total_tokens), 0)::bigint AS tok,
         (SELECT string_agg(g.m, ', ') FROM (
            SELECT COALESCE(NULLIF(s2."model_group", ''), NULLIF(s2."model", ''), '?') m
            FROM "LiteLLM_SpendLogs" s2 WHERE s2.session_id = $1 GROUP BY m ORDER BY count(*) DESC LIMIT 3) g) AS models
  FROM "LiteLLM_SpendLogs" s
  WHERE s.session_id = $1 AND s."startTime" >= (now() AT TIME ZONE 'utc') - make_interval(days => $2::int)
  GROUP BY s."user"
), last AS (
  SELECT proxy_server_request AS psr FROM "LiteLLM_SpendLogs"
  WHERE session_id = $1 AND proxy_server_request IS NOT NULL
  ORDER BY "startTime" DESC LIMIT 1
), rep AS (
  SELECT string_agg(left(regexp_replace(
           CASE jsonb_typeof(m2 -> 'content')
             WHEN 'string' THEN m2 ->> 'content'
             ELSE (SELECT string_agg(p ->> 'text', ' ') FROM jsonb_array_elements(m2 -> 'content') p
                   WHERE p ->> 'type' = 'text')
           END, '\\s+', ' ', 'g'), 400), E'\n---\n') AS txts
  FROM last, jsonb_array_elements(last.psr -> 'messages') e(m2)
  WHERE e.m2 ->> 'role' = 'user'
)
SELECT 'сессия ' || $1 || ' | участник ' || COALESCE(nullif(uu.user_email, ''), nullif(m.u, ''), 'аноним')
  || ' | запросов ' || m.turns || ' | токенов ' || m.tok || ' | модели: ' || COALESCE(m.models, '')
  || E'\nРЕПЛИКИ:\n' || left(COALESCE(rep.txts, '(текстов нет)'), 12000) AS dig
FROM m LEFT JOIN "LiteLLM_UserTable" uu ON uu.user_id = m.u, rep;
"""


@router.post("/dashboard/journal/evaluate", tags=["journal"], include_in_schema=False)
async def post_journal_evaluate(
    request: Request,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    import httpx

    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})

    body = await request.json()
    days = int(body.get("days") or 1)
    model = str(body.get("model") or "")
    dt_from = str(body.get("from") or "").replace("T", " ")[:16]
    dt_to = str(body.get("to") or "").replace("T", " ")[:16]
    target_u = str(body.get("u") or "")
    target_sid = str(body.get("sid") or "")
    absolute = bool(dt_from and dt_to) and not target_sid
    if absolute:
        try:
            f_dt = datetime.strptime(dt_from, "%Y-%m-%d %H:%M")
            t_dt = datetime.strptime(dt_to, "%Y-%m-%d %H:%M")
        except ValueError as e:
            raise HTTPException(status_code=400, detail={"error": "Период: ждём «YYYY-MM-DD HH:MM»"}) from e
        span = (t_dt - f_dt).total_seconds()
        if span <= 0:
            raise HTTPException(status_code=400, detail={"error": "Период: начало должно быть раньше конца"})
        if span > 31 * 86400:
            raise HTTPException(status_code=400, detail={"error": "Период: не больше 31 суток"})
        days_eff = max(1, math.ceil(span / 86400))
        win_txt = f"за период {dt_from} → {dt_to} (Владивосток)"
    else:
        if not 1 <= days <= _EVAL_MAX_DAYS:
            raise HTTPException(status_code=400, detail={"error": f"Окно оценки: 1–{_EVAL_MAX_DAYS} суток"})
        days_eff = days
        win_txt = f"за последние {days} суток"
    if not model:
        raise HTTPException(status_code=400, detail={"error": "Не выбрана модель"})

    if not _table_ready["ok"]:
        await prisma_client.db.execute_raw(_CREATE_TABLE)
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "targetU" text NOT NULL DEFAULT \'\''
        )
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "targetSid" text NOT NULL DEFAULT \'\''
        )
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "periodFrom" text NOT NULL DEFAULT \'\''
        )
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "periodTo" text NOT NULL DEFAULT \'\''
        )
        _table_ready["ok"] = True

    if target_sid:
        srows = await prisma_client.db.query_raw(_SQL_SESSION_DIGEST, target_sid, days)
        digest = srows[0]["dig"] if srows else ""
        if not digest:
            raise HTTPException(status_code=404, detail={"error": "сессия не найдена за окно ≤ 7 суток"})
        prompt = (
            "Это начало и статистика одной сессии сотрудника с нашего внутреннего гейтвея ИИ. Кратко "
            "(10–15 строк, markdown): ## Чем занимались — буллеты; ## Чем закончилось — 1–2 строки; "
            "**Характер:** реальная работа / обучение / развлечения / автоматика; ## Оценка полезности — "
            "2–3 строки. Только по данным, без выдумок. По-русски, без черновика.\n\n" + digest
        )
    else:
        a_from = dt_from if absolute else ""
        a_to = dt_to if absolute else ""
        win_s, wparams, _ = _win_clause('s."startTime"', days_eff, a_from, a_to)
        win_p, _, _ = _win_clause('"startTime"', days_eff, a_from, a_to)
        parts_sql = _SQL_PARTICIPANTS.format(tz=_TZ, filt="", ire=_INTERACTIVE_RE, win=win_s)
        first_sql = _SQL_FIRST.format(tz=_TZ, txtf=_TXT_FILTER, eu=_EVAL_USER, win=win_p)
        parts = await _rows(prisma_client, parts_sql, *wparams)
        first = await _rows(prisma_client, first_sql, *wparams)
        if target_u:
            tgt = next((p for p in parts if p["u"] == target_u), None)
            disp = _disp(target_u, (tgt or {}).get("email") or "", await _safe_names(prisma_client))
            prompt = (
                f"Это сводка с нашего внутреннего гейтвея LiteLLM {win_txt} по сотруднику "
                f"**{disp}**. Только по данным, без выдумок, по-русски, сразу итоговый ответ без черновика. "
                "Структура (markdown): ## Чем занят — 2–4 буллета (проекты, задачи, системы из реплик); "
                "строка **Характер:** реальная работа / обучение-эксперименты / развлечения / сервисная "
                "автоматизация; ## Сессии — частота, длина, тон (2–3 строки); ## Итог — 2–3 строки."
            )
            digest = _build_digest(parts, first, await _safe_names(prisma_client), target_u)
        else:
            digest = _build_digest(parts, first, await _safe_names(prisma_client))
            prompt = _EVAL_PROMPT.format(win=win_txt)
        prompt = prompt + "\n\n" + digest

    base = os.environ.get("LITELLM_SELF_BASE", "https://dgk00srv937d.dgk.ru")
    master = os.environ.get("LITELLM_MASTER_KEY", "")
    t0 = time.time()
    report = ""
    error = ""
    try:
        async with httpx.AsyncClient(verify=False, timeout=httpx.Timeout(300.0)) as client:
            resp = await client.post(
                f"{base}/v1/chat/completions",
                headers={"Authorization": f"Bearer {master}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 9000,
                    "temperature": 0.3,
                    "user": _EVAL_USER,
                    # qwen3.8 через гейт без thinking=false отдаёт content:null (ответ в reasoning_content)
                    "chat_template_kwargs": {"thinking": False},
                },
            )
            resp.raise_for_status()
            msg = resp.json()["choices"][0]["message"]
            report = (msg.get("content") or msg.get("reasoning_content") or "").strip()
            if not report:
                error = "пустой ответ модели"
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {str(e)[:300]}"

    gen_s = round(time.time() - t0, 1)
    rows = await prisma_client.db.query_raw(
        f"INSERT INTO {_SNAP_TABLE} (\"periodDays\", model, \"digestChars\", report, \"createdBy\", error, "
        "\"targetU\", \"targetSid\", \"periodFrom\", \"periodTo\") "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
        days_eff,
        model,
        len(digest),
        report,
        user_api_key_dict.user_id or "admin",
        error,
        target_u,
        target_sid,
        dt_from if absolute else "",
        dt_to if absolute else "",
    )
    return {
        "id": rows[0]["id"] if rows else None,
        "report": report,
        "error": error,
        "gen_s": gen_s,
        "digest_chars": len(digest),
    }


@router.get("/dashboard/journal/evaluations", tags=["journal"], include_in_schema=False)
async def get_journal_evaluations(
    response: Response,
    limit: int = Query(default=30, ge=1, le=100),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})
    if not _table_ready["ok"]:
        await prisma_client.db.execute_raw(_CREATE_TABLE)
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "targetU" text NOT NULL DEFAULT \'\''
        )
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "targetSid" text NOT NULL DEFAULT \'\''
        )
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "periodFrom" text NOT NULL DEFAULT \'\''
        )
        await prisma_client.db.execute_raw(
            f'ALTER TABLE {_SNAP_TABLE} ADD COLUMN IF NOT EXISTS "periodTo" text NOT NULL DEFAULT \'\''
        )
        _table_ready["ok"] = True
    rows = await prisma_client.db.query_raw(
        f"SELECT id, to_char(\"createdAt\" AT TIME ZONE 'UTC' AT TIME ZONE '{_TZ}', 'YYYY-MM-DD HH24:MI') AS created, "
        "\"periodDays\", model, \"digestChars\", length(report) AS rlen, error, \"createdBy\", "
        "\"targetU\", \"targetSid\", \"periodFrom\", \"periodTo\", "
        "left(report, 200) AS preview "
        f"FROM {_SNAP_TABLE} ORDER BY id DESC LIMIT $1",
        limit,
    )
    return {"items": [dict(r) for r in rows]}


@router.get("/dashboard/journal/evaluation", tags=["journal"], include_in_schema=False)
async def get_journal_evaluation(
    response: Response,
    id: int = Query(...),
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    from litellm.proxy.proxy_server import prisma_client

    if user_api_key_dict.user_role not in _JOURNAL_ALLOWED_ROLES:
        raise HTTPException(status_code=403, detail={"error": "Журнал доступен только администраторам"})
    if prisma_client is None:
        raise HTTPException(status_code=503, detail={"error": "Нет БД"})
    rows = await prisma_client.db.query_raw(
        f"SELECT id, report, error, model, \"periodDays\" FROM {_SNAP_TABLE} WHERE id = $1", id
    )
    if not rows:
        raise HTTPException(status_code=404, detail={"error": "оценка не найдена"})
    return dict(rows[0])
