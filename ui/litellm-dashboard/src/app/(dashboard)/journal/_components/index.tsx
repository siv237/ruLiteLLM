"use client";

// fork: панель «Журнал активности» (замена enterprise-журнала аудита, v1 08.10.2026).
// Слой 1 — журнал (тепловая карта, участники, последние начала сессий) — чистый SQL.
// Слой 2 — «Оценить период» — ручной вызов модели, летопись оценок.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/components/networking";
import Heatmap from "./heatmap";
import DetailModal from "./detailModal";
import EvalList from "./evalList";
import EvaluateDialog from "./evaluate";
import UserView from "./userView";
import {
  cleanTxt,
  fmtDelta,
  fmtKtok,
  fmtWhen,
  fnum,
  TYPE_BADGE,
  userHues,
  type CellT,
  type EvaluationT,
  type RecentT,
  type StateResponse,
} from "./shared";

type RecentGroupT = RecentT & { n: number };

interface Props {
  accessToken: string;
}

export default function Journal({ accessToken }: Props) {
  const [days, setDays] = useState(30);
  const [model, setModel] = useState("");
  const [agent, setAgent] = useState("");
  const [key, setKey] = useState("");
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<EvaluationT[]>([]);
  const [showEval, setShowEval] = useState(false);
  const [evalTarget, setEvalTarget] = useState<{ u?: string; sid?: string; display?: string } | null>(null);
  const [detail, setDetail] = useState<RecentGroupT | null>(null);
  const [evalCell, setEvalCell] = useState<CellT | null>(null);
  const [hideSys, setHideSys] = useState(() => {
    try {
      return localStorage.getItem("journal-hide-sys") !== "0";
    } catch {
      return true;
    }
  });

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const q = new URLSearchParams({ days: String(days) });
      if (model) q.set("model", model);
      if (agent) q.set("agent", agent);
      if (key) q.set("key", key);
      const r = await apiClient.get<StateResponse>(`/dashboard/journal/state?${q}`, { accessToken });
      setData(r);
      setError("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [accessToken, days, model, agent, key]);

  const loadEvals = useCallback(async () => {
    if (!accessToken) return;
    try {
      const r = await apiClient.get<{ items: EvaluationT[] }>("/dashboard/journal/evaluations?limit=30", { accessToken });
      setEvaluations(r.items || []);
    } catch {
      /* летопись не критична */
    }
  }, [accessToken]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadEvals();
  }, [loadEvals]);

  const hues = useMemo(
    () => userHues(data ? [...data.participants.map((p) => p.display), ...data.recent.map((r2) => r2.display)] : []),
    [data],
  );

  // серваки шлют один и тот же промпт поминутно — склеиваем повторы в одну строку со счётчиком
  const recentGroups = useMemo<RecentGroupT[]>(() => {
    const out: RecentGroupT[] = [];
    const at = new Map<string, number>();
    for (const r of data?.recent || []) {
      const k = `${r.u}\u0000${r.txt}`;
      const i = at.get(k);
      if (i !== undefined) out[i].n += 1;
      else {
        at.set(k, out.length);
        out.push({ ...r, n: 1 });
      }
    }
    return out;
  }, [data]);

  const sysDisplays = useMemo(
    () => new Set((data?.participants || []).filter((p) => p.type !== "human").map((p) => p.display)),
    [data],
  );
  const visibleRecent = useMemo(
    () => (hideSys ? recentGroups.filter((g) => !sysDisplays.has(g.display)) : recentGroups),
    [recentGroups, hideSys, sysDisplays],
  );
  const [shown, setShown] = useState(50);
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setShown(50);
  }, [data, hideSys]);
  const onFeedScroll = () => {
    const el = feedRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 120) setShown((s) => s + 50);
  };

  // не-anализирующие модели (эмбеддинги, rerank, decision-класс clef) не могут писать отчёты — исключаем из выбора оценки
  const chatModels = useMemo(() => (data?.models || []).filter((m) => !/(embed|rerank|moderation|clip|clef|judge|bge|snowflake)/i.test(m)), [data]);

  if (selected) {
    return (
      <>
        <UserView
          accessToken={accessToken}
          u={selected}
          onBack={() => setSelected(null)}
          onEvaluate={(t) => {
            setEvalTarget(t || null);
            setEvalCell(null);
            setShowEval(true);
          }}
          evaluations={evaluations}
        />
        {showEval && (
          <EvaluateDialog
            accessToken={accessToken}
            models={chatModels}
            target={evalTarget || undefined}
            cell={evalCell}
            onClose={() => {
              setShowEval(false);
              setEvalCell(null);
            }}
            onDone={loadEvals}
          />
        )}
      </>
    );
  }

  const t = data?.totals;
  const dReqs = t && fmtDelta(t.reqs, t.prev_reqs);
  const dPeople = t && fmtDelta(t.people, t.prev_people);

  const kpi = (label: string, value: string, delta?: { txt: string; up: boolean } | null, hint?: string) => (
    <div className="rounded border border-input bg-card px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        {delta ? (
          <span className={`text-[10px] ${delta.up ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>{delta.txt}</span>
        ) : (
          <span className="text-[10px] text-muted-foreground">{hint || "к предыдущему периоду"}</span>
        )}
      </div>
      <div className="text-xl font-bold leading-tight tabular-nums">{value}</div>
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Журнал активности</h1>
          <div className="text-xs text-muted-foreground">Кто и как пользуется ИИ · только администраторы</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded border border-input bg-background px-2 py-1.5 text-xs"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>последние 7 дней</option>
            <option value={30}>последние 30 дней</option>
            <option value={90}>90 дней</option>
          </select>
          <button
            className="rounded border border-input bg-background px-3 py-1.5 text-xs hover:bg-muted"
            onClick={() => {
              load();
              loadEvals();
            }}
            title="перечитать журнал и летопись"
          >
            ⟳ Обновить
          </button>
          <button
            className="rounded border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
            onClick={() => {
              setEvalTarget(null);
              setEvalCell(null);
              setShowEval(true);
            }}
          >
            Оценить период
          </button>
        </div>
      </div>

      <div className="shrink-0 rounded border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-muted-foreground">
        Журнал текстов ведётся с 06.10.2026 — ранее доступна только статистика. Время — Владивосток (UTC+10).
      </div>

      {error && <div className="shrink-0 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600">{error}</div>}

      <div className="grid shrink-0 gap-3 xl:grid-cols-[1.35fr_1fr]">
        <div className="min-w-0 overflow-hidden rounded border border-input bg-card p-3">
          <div className="mb-2 text-sm font-medium">Активность</div>
          {data ? (
            <Heatmap
              cells={data.cells}
              onCellClick={(c) => {
                setEvalCell(c);
                setEvalTarget(null);
                setShowEval(true);
              }}
            />
          ) : (
            <div className="text-xs text-muted-foreground">загрузка…</div>
          )}
        </div>
        <div className="grid min-w-0 grid-cols-[1fr_1.2fr] gap-3">
          <div className="grid content-start gap-2">
            {kpi("Запросы", t ? fnum(t.reqs) : "…", dReqs)}
            {kpi("Участники", t ? fnum(t.participants) : "…", null, "люди + системы")}
            {kpi("Люди", t ? fnum(t.people) : "…", dPeople)}
            {kpi("Системы", t ? fnum(t.systems) : "…", null, "боты и сервисы")}
            {kpi("Пиковый час", t?.peak_hour != null ? `${String(t.peak_hour).padStart(2, "0")}:00` : "…", null, "максимум запросов по часам")}
          </div>
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-input bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2 whitespace-nowrap">
              <span className="text-sm font-medium">Анализ ИИ</span>
              <span className="truncate text-[10px] text-muted-foreground">оценки периодов · клик — читать</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <EvalList
                accessToken={accessToken}
                items={evaluations.filter((ev) => !ev.targetU && !ev.targetSid)}
                empty="Общих оценок пока нет. Нажмите «Оценить период» — модель прочитает дайджест журнала и напишет отчёт (~1 мин)."
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[1.35fr_1fr]">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-input bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Участники</span>
            <div className="flex items-center gap-2 text-[11px]">
              <select
                className="rounded border border-input bg-background px-2 py-1"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                title="фильтр по модели"
              >
                <option value="">Все модели</option>
                {(data?.models || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                className="w-28 rounded border border-input bg-background px-2 py-1"
                placeholder="агент (UA)"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                onBlur={load}
                onKeyDown={(e) => e.key === "Enter" && load()}
              />
              <input
                className="w-28 rounded border border-input bg-background px-2 py-1"
                placeholder="ключ"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onBlur={load}
                onKeyDown={(e) => e.key === "Enter" && load()}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-muted-foreground">
                  <th className="pr-2 font-normal">Участник</th>
                  <th className="pr-2 font-normal">Тип</th>
                  <th className="pr-2 text-right font-normal">Запросы</th>
                  <th className="pr-2 text-right font-normal">Токены</th>
                  <th className="pr-2 text-right font-normal">Сессии</th>
                  <th className="pr-2 text-right font-normal" title="user-реплики в последнем теле сессии (тексты с 06.10)">
                    Обмены
                  </th>
                  <th className="pr-2 font-normal">Активные часы</th>
                  <th className="text-right font-normal">Последняя активность</th>
                </tr>
              </thead>
              <tbody>
                {(data?.participants || []).map((p) => (
                  <tr
                    key={p.u || "anon"}
                    className="cursor-pointer border-t border-input/40 hover:bg-muted/50"
                    onClick={() => setSelected(p.u)}
                    title="открыть страницу участника"
                  >
                    <td className="max-w-[10rem] truncate py-1.5 pr-2">
                      <span
                        className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle"
                        style={{ backgroundColor: `hsl(${hues.get(p.display) ?? 0} 65% 55%)` }}
                      />
                      {p.display}
                    </td>
                    <td className="pr-2">
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${TYPE_BADGE[p.type].cls}`}>
                        {TYPE_BADGE[p.type].label}
                      </span>
                    </td>
                    <td className="pr-2 text-right tabular-nums">{fnum(p.reqs)}</td>
                    <td className="pr-2 text-right tabular-nums">{fmtKtok(p.tok)}</td>
                    <td className="pr-2 text-right tabular-nums">{fnum(p.sess)}</td>
                    <td className="pr-2 text-right tabular-nums">{fnum(p.exch)}</td>
                    <td className="pr-2 tabular-nums text-muted-foreground">{p.hours}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{p.t_last}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && !data.participants.length && <div className="py-6 text-center text-xs text-muted-foreground">нет данных за период</div>}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-input bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Последняя активность</span>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-muted-foreground" title="скрыть сервисные аккаунты, ботов и анонимов">
              <input
                type="checkbox"
                className="h-3 w-3 accent-primary"
                checked={hideSys}
                onChange={(e) => {
                  setHideSys(e.target.checked);
                  try {
                    localStorage.setItem("journal-hide-sys", e.target.checked ? "1" : "0");
                  } catch {
                    /* localStorage может быть недоступен */
                  }
                }}
              />
              скрыть системных
            </label>
          </div>
          <div ref={feedRef} onScroll={onFeedScroll} className="min-h-0 flex-1 overflow-y-auto">
            {visibleRecent.slice(0, shown).map((g, i) => (
              <div
                key={i}
                className="cursor-pointer border-t border-input/40 py-1.5 first:border-t-0 hover:bg-muted/40"
                onClick={() => setDetail(g)}
                title="показать строку целиком"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: `hsl(${hues.get(g.display) ?? 0} 65% 55%)` }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{g.display}</span>
                  {g.n > 1 && (
                    <span className="shrink-0 rounded-full border border-input px-1.5 text-[10px] tabular-nums text-muted-foreground" title="повторов такой же строки">
                      ×{g.n}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title="запросов в сессии">
                    {g.turns} зап.
                  </span>
                  <span className="w-[7.5rem] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{fmtWhen(g.t, data?.now || 0)}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 pl-3.5 text-[11px] leading-snug break-words text-muted-foreground">{cleanTxt(g.txt)}</div>
              </div>
            ))}
            {visibleRecent.length > shown && (
              <div className="py-2 text-center text-[10px] text-muted-foreground">
                показано {shown} из {visibleRecent.length} — листайте вниз, подгрузим дальше в прошлое
              </div>
            )}
            {data && !visibleRecent.length && (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {recentGroups.length ? "все записи за период — системные; снимите галочку" : "нет сессий с текстами за период"}
              </div>
            )}
          </div>
        </div>
      </div>

      {detail && (
        <DetailModal
          accessToken={accessToken}
          item={detail}
          hue={hues.get(detail.display) ?? 0}
          onClose={() => setDetail(null)}
          onOpenUser={(u) => {
            setSelected(u);
            setDetail(null);
          }}
        />
      )}

      {showEval && (
        <EvaluateDialog
          accessToken={accessToken}
          models={chatModels}
          target={evalTarget || undefined}
          onClose={() => setShowEval(false)}
          onDone={loadEvals}
        />
      )}
    </div>
  );
}
