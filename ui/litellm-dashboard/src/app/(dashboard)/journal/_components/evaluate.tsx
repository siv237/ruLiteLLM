"use client";

// fork: слой 2 — ручная «оценка периода» (дайджест → один запрос к выбранной модели); период свой или пресет
// + вкладка «Быстрый анализ» — кто/когда/что запросил в окне (чистый SQL, без LLM)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiClient } from "@/components/networking";
import { downloadMd, fmtKtok, REPORT_PROSE_CLS, type CellT, type EvaluationT } from "./shared";

const LS_MODEL = "journal-eval-model";

const pad = (n: number) => String(n).padStart(2, "0");

// epoch ms → «YYYY-MM-DDTHH:MM» по Владивостоку (UTC+10, без DST)
function localIso(ms: number): string {
  return new Date(ms + 10 * 3600_000).toISOString().slice(0, 16);
}

function cellRange(c: CellT): { from: string; to: string } {
  const start = Date.UTC(+c.d.slice(0, 4), +c.d.slice(5, 7) - 1, +c.d.slice(8, 10), c.h);
  return { from: new Date(start).toISOString().slice(0, 16), to: new Date(start + 3600_000).toISOString().slice(0, 16) };
}

interface WindowRowT {
  t: string;
  u: string;
  display: string;
  kind: string;
  sid: string;
  tok: number;
  m: string;
}
interface WindowSummaryT {
  u: string;
  display: string;
  kind: string;
  reqs: number;
  tok: number;
  sess: number;
}

interface Props {
  accessToken: string;
  models: string[];
  evaluations: EvaluationT[];
  onClose: () => void;
  onDone: () => void;
  target?: { u?: string; sid?: string; display?: string };
  cell?: CellT | null;
}

export default function EvaluateDialog({ accessToken, models, evaluations, onClose, onDone, target, cell }: Props) {
  const isSession = !!target?.sid;
  const [custom, setCustom] = useState(!!cell && !isSession);
  const [days, setDays] = useState(isSession ? 7 : 1);
  const init = useMemo(() => (cell && !isSession ? cellRange(cell) : { from: localIso(Date.now() - 86400_000), to: localIso(Date.now()) }), [cell, isSession]);
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState("");
  const [tab, setTab] = useState<"quick" | "ai">("quick");
  const [qRows, setQRows] = useState<WindowRowT[]>([]);
  const [qSumm, setQSumm] = useState<WindowSummaryT[]>([]);
  const [qTrunc, setQTrunc] = useState(false);
  const [qBusy, setQBusy] = useState(false);
  const [qErr, setQErr] = useState("");
  const qReq = useRef(0);

  useEffect(() => {
    if (model && models.includes(model)) return;
    let saved = "";
    try {
      saved = localStorage.getItem(LS_MODEL) || "";
    } catch {
      /* localStorage может быть недоступен */
    }
    setModel(saved && models.includes(saved) ? saved : models[0] || "");
  }, [models, model]);

  useEffect(() => {
    if (cell && !isSession) {
      const r = cellRange(cell);
      setCustom(true);
      setFrom(r.from);
      setTo(r.to);
    }
  }, [cell, isSession]);

  const periodParams = useMemo(() => {
    const q = new URLSearchParams();
    if (custom) {
      q.set("dt_from", from.replace("T", " "));
      q.set("dt_to", to.replace("T", " "));
    } else {
      q.set("days", String(days));
    }
    return q.toString();
  }, [custom, from, to, days]);

  const loadQuick = useCallback(async () => {
    if (!accessToken) return;
    const my = ++qReq.current;
    setQBusy(true);
    setQErr("");
    try {
      const r = await apiClient.get<{ rows: WindowRowT[]; summary: WindowSummaryT[]; truncated: boolean }>(`/dashboard/journal/window?${periodParams}`, { accessToken });
      if (my !== qReq.current) return;
      setQRows(r.rows || []);
      setQSumm(r.summary || []);
      setQTrunc(!!r.truncated);
    } catch (e) {
      if (my !== qReq.current) return;
      setQErr(String(e instanceof Error ? e.message : e));
    } finally {
      if (my === qReq.current) setQBusy(false);
    }
  }, [accessToken, periodParams]);

  // быстрый анализ: сразу при открытии и при смене периода (с дебаунсом набора)
  useEffect(() => {
    const t = setTimeout(loadQuick, 400);
    return () => clearTimeout(t);
  }, [loadQuick]);

  // если ИИ-анализ этого периода уже выполнялся — подставляем его без повтора
  useEffect(() => {
    const tu = target?.u || "";
    const ts = target?.sid || "";
    const match = evaluations.find(
      (ev) =>
        !ev.error &&
        (ev.targetU || "") === tu &&
        (ev.targetSid || "") === ts &&
        (custom ? (ev.periodFrom || "").replace("T", " ") === from.replace("T", " ") && (ev.periodTo || "").replace("T", " ") === to.replace("T", " ") : !ev.periodFrom && ev.periodDays === days),
    );
    if (!match) return;
    let alive = true;
    apiClient
      .get<{ report: string; model: string }>(`/dashboard/journal/evaluation?id=${match.id}`, { accessToken })
      .then((r) => {
        if (!alive) return;
        setReport(r.report || "");
        setMeta(`уже выполнялся: оценка #${match.id} от ${match.created} · модель ${r.model || match.model}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickModel = (m: string) => {
    setModel(m);
    try {
      localStorage.setItem(LS_MODEL, m);
    } catch {
      /* localStorage может быть недоступен */
    }
  };

  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400_000;
  const customOk = !custom || (from < to && spanDays > 0 && spanDays <= 31);
  const periodTxt = custom ? `${from.replace("T", " ")} → ${to.replace("T", " ")}` : `последние ${days} сут`;

  const run = async () => {
    setBusy(true);
    setError("");
    setReport("");
    setMeta("");
    setTab("ai");
    try {
      const body = custom
        ? { days: 0, model, u: target?.u || "", sid: target?.sid || "", from: from.replace("T", " "), to: to.replace("T", " ") }
        : { days, model, u: target?.u || "", sid: target?.sid || "" };
      const r = await apiClient.post<{ report: string; error: string; gen_s: number; digest_chars: number }>(
        "/dashboard/journal/evaluate",
        { accessToken, body },
      );
      setReport(r.report || "");
      setError(r.error || "");
      setMeta(`модель ${model} · период ${periodTxt} · дайджест ${r.digest_chars} симв. · генерация ${r.gen_s} с`);
      onDone();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const tabCls = (on: boolean) =>
    `rounded-t border-b-0 px-3 py-1.5 text-xs ${on ? "border-input bg-card font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : onClose}>
      <div
        className="flex h-[80vh] w-[80vw] max-w-[1400px] flex-col rounded-lg border border-input bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">
              {isSession
                ? `Оценка сессии · ${target?.display || ""}`
                : cell
                  ? `Оценка · кирпич ${cell.d.slice(5)} ${pad(cell.h)}:00`
                  : target?.u
                    ? `Оценка периода · ${target.display}`
                    : "Оценка периода"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {isSession
                ? "дайджест сессии → один запрос к модели. Запуск только вручную."
                : cell
                  ? "период подставлен по кирпичику тепловой карты — начало и конец можно поменять"
                  : "дайджест журнала → один запрос к модели → отчёт «кто чем занят». Запуск только вручную."}
            </div>
          </div>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            Период
            <select
              className="rounded border border-input bg-background px-2 py-1 text-xs"
              value={custom ? "custom" : days}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  setCustom(true);
                  setFrom(localIso(Date.now() - 86400_000));
                  setTo(localIso(Date.now()));
                } else {
                  setCustom(false);
                  setDays(Number(e.target.value));
                }
              }}
              disabled={busy || isSession}
            >
              <option value={1}>последние 24 часа</option>
              <option value={3}>3 суток</option>
              <option value={7}>7 суток</option>
              {!isSession && <option value="custom">свой период…</option>}
            </select>
          </label>
          {custom && (
            <>
              <input
                type="datetime-local"
                className="rounded border border-input bg-background px-2 py-1 text-xs tabular-nums"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={busy}
                title="начало (Владивосток)"
              />
              <span className="text-xs text-muted-foreground">→</span>
              <input
                type="datetime-local"
                className="rounded border border-input bg-background px-2 py-1 text-xs tabular-nums"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={busy}
                title="конец (Владивосток)"
              />
              {!customOk && <span className="text-[10px] text-red-500">проверьте границы (≤ 31 сут)</span>}
            </>
          )}
          <label className="flex items-center gap-2 text-xs">
            Модель
            <select
              className="rounded border border-input bg-background px-2 py-1 text-xs"
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              disabled={busy}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            onClick={run}
            disabled={busy || !model || !customOk}
          >
            {busy ? "генерация ~1 мин…" : "Оценить"}
          </button>
          {report && !busy && (
            <button
              className="rounded border border-input px-3 py-1.5 text-xs hover:bg-muted/50"
              onClick={() =>
                downloadMd(
                  `ai-otsenka-${(target?.u || target?.sid || "period").slice(0, 24)}-${periodTxt.replace(/[^0-9A-Za-zА-Яа-я.]+/g, "-")}.md`,
                  `# Оценка ИИ · ${target?.display || target?.u || target?.sid || "период журнала"} · ${periodTxt}\n\nмодель ${model}${meta ? ` · ${meta}` : ""}\n\n---\n\n${report}`,
                )
              }
            >
              Скачать .md
            </button>
          )}
        </div>

        <div className="flex items-end gap-1 border-b border-input">
          <button className={tabCls(tab === "quick")} onClick={() => setTab("quick")}>
            Быстрый анализ
          </button>
          <button className={tabCls(tab === "ai")} onClick={() => setTab("ai")}>
            ИИ анализ{report ? " •" : ""}
          </button>
          <span className="ml-auto pb-1 text-[10px] text-muted-foreground">{periodTxt}</span>
        </div>

        {tab === "quick" && (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-b border border-input bg-background p-3">
            {qErr && <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">{qErr}</div>}
            {qBusy && !qRows.length && <div className="text-xs text-muted-foreground">загрузка…</div>}
            {!qBusy && !qErr && !qRows.length && <div className="text-xs text-muted-foreground">в этом периоде запросов нет.</div>}
            {!!qSumm.length && (
              <div className="mb-2 flex flex-wrap gap-2">
                {qSumm.map((s) => (
                  <span key={s.u} className="rounded border border-input bg-card px-2 py-1 text-[11px]">
                    {s.display}
                    {s.kind === "system" ? " [система]" : ""} · {s.reqs} зап. · {fmtKtok(s.tok)} ток.
                    {s.sess ? ` · ${s.sess} сесс.` : ""}
                  </span>
                ))}
              </div>
            )}
            {!!qRows.length && (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="sticky top-0 bg-background py-1 pr-3 font-medium">Время</th>
                    <th className="sticky top-0 bg-background py-1 pr-3 font-medium">Участник</th>
                    <th className="sticky top-0 bg-background py-1 pr-3 font-medium">Модель</th>
                    <th className="sticky top-0 bg-background py-1 pr-3 text-right font-medium">Токены</th>
                    <th className="sticky top-0 bg-background py-1 font-medium">Сессия</th>
                  </tr>
                </thead>
                <tbody>
                  {qRows.map((r, i) => (
                    <tr key={i} className="border-t border-input/40">
                      <td className="py-1 pr-3 tabular-nums">{r.t}</td>
                      <td className="py-1 pr-3">
                        {r.display}
                        {r.kind === "system" ? " [система]" : ""}
                      </td>
                      <td className="py-1 pr-3">{r.m}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtKtok(r.tok)}</td>
                      <td className="max-w-[160px] truncate py-1 text-muted-foreground" title={r.sid}>
                        {r.sid}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {qTrunc && <div className="mt-2 text-[10px] text-muted-foreground">показаны последние 500 запросов</div>}
          </div>
        )}

        {tab === "ai" && (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-b border border-input bg-background p-5">
            {error && <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
            {report ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
            ) : busy ? (
              <span className="text-muted-foreground">Модель читает дайджест и пишет отчёт…</span>
            ) : (
              <span className="text-muted-foreground">ИИ-анализ этого периода ещё не выполнялся — нажмите «Оценить».</span>
            )}
            {meta && <div className="mt-2 text-[10px] text-muted-foreground">{meta}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
