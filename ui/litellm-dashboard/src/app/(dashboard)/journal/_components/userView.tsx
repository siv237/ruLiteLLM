"use client";

// fork: страница участника журнала (v1 — без тем/проектов, темы появятся из оценок)

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/components/networking";
import EvalList from "./evalList";
import { cleanTxt, fmtKtok, fnum, type EvaluationT, type UserResponse } from "./shared";

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - (v / max) * 26}`).join(" ");
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-7 w-full">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sky-500" />
    </svg>
  );
}

interface Props {
  accessToken: string;
  u: string;
  onBack: () => void;
  onEvaluate: (target?: { u?: string; sid?: string; display?: string }) => void;
  evaluations: EvaluationT[];
}

export default function UserView({ accessToken, u, onBack, onEvaluate, evaluations }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const millionUnit = t("journal.unitMillion");
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UserResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<UserResponse>(`/dashboard/journal/user?u=${encodeURIComponent(u)}&days=${days}`, {
        accessToken,
      });
      setData(r);
      setError("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [accessToken, u, days]);

  useEffect(() => {
    load();
  }, [load]);

  const exportMd = () => {
    if (!data) return;
    const lines = [
      `# ${t("journal.exportTitle", { display: data.display, ident: data.email || data.u, days: data.days })}`,
      "",
      t("journal.exportTotals", {
        reqs: data.totals.reqs,
        tok: data.totals.tok,
        sess: data.totals.sess,
        exch: data.totals.exch,
      }),
      "",
      t("journal.exportTableHeader"),
      "|---|---|---|---|---|",
      ...data.sessions.map((s) => `| ${s.t0} | ${s.model} | ${s.tok} | ${s.exch} | ${s.first.replace(/\|/g, "\\|")} |`),
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
    a.download = `journal-${data.display}-${data.days}d.md`;
    a.click();
  };

  const tot = data?.totals;
  const kpi = (label: string, value: string, hint?: string) => (
    <div className="rounded border border-input bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <button className="w-fit text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>
        ← {t("journal.backToJournal")}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-500/15 text-sm font-semibold text-sky-600 dark:text-sky-400">
            {(data?.display || "?").slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="text-base font-semibold">{data?.display || "…"}</div>
            <div className="text-[11px] text-muted-foreground">{data?.email || data?.u || ""}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="rounded border border-input bg-background px-2 py-1.5 text-xs"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={1}>{t("journal.range24h")}</option>
            <option value={7}>{t("journal.range7d")}</option>
            <option value={30}>{t("journal.range30d")}</option>
          </select>
          <button
            className="rounded border border-input bg-background px-3 py-1.5 text-xs hover:bg-muted"
            onClick={exportMd}
            disabled={!data}
          >
            {t("journal.exportMd")}
          </button>
          <button
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => onEvaluate({ u, display: data?.display })}
          >
            {t("journal.evaluatePeriod")}
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600">{error}</div>}

      <div className="grid shrink-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpi(t("journal.kpiRequestsTotal"), tot ? fnum(tot.reqs, locale) : "…")}
        {kpi(t("journal.kpiTokens"), tot ? fmtKtok(tot.tok, millionUnit) : "…")}
        {kpi(t("journal.kpiSessions"), tot ? fnum(tot.sess, locale) : "…", t("journal.kpiSessionsHint"))}
        {kpi(t("journal.kpiExchanges"), tot ? fnum(tot.exch, locale) : "…", t("journal.kpiExchangesHint"))}
        <div className="rounded border border-input bg-card p-3">
          <div className="text-[11px] text-muted-foreground">{t("journal.topModels")}</div>
          <div className="mt-1 space-y-0.5">
            {(data?.top_models || []).slice(0, 3).map((m) => (
              <div key={m.m} className="flex justify-between text-[11px]">
                <span className="max-w-[8rem] truncate" title={m.m}>
                  {m.m}
                </span>
                <span className="tabular-nums text-muted-foreground">{m.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[1.6fr_1fr]">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-input bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t("journal.sessionLog")}</span>
            <span className="text-[10px] text-muted-foreground">
              {t("journal.sessionLogNote", {
                longest: t("journal.longestMinutes", { count: data?.facts.longest_min || 0 }),
                agent: data?.facts.top_agent ? ` · ${t("journal.agentLabel", { agent: data.facts.top_agent.split("/")[0] })}` : "",
              })}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-1 text-muted-foreground">
              <Spark values={(data?.daily || []).map((d) => d.n)} />
            </div>
            <div className="grid grid-cols-[8.5rem_5rem_minmax(0,1fr)_5rem_6rem_7rem] items-center gap-x-3 border-b border-input/40 pb-1 text-[10px] text-muted-foreground">
              <span>{t("journal.colStart")}</span>
              <span className="text-right">{t("journal.colDuration")}</span>
              <span>{t("journal.colModel")}</span>
              <span className="text-right">{t("journal.colTokens")}</span>
              <span className="text-right" title={t("journal.colExchReqsTooltip")}>
                {t("journal.colExchReqs")}
              </span>
              <span className="text-right">{t("journal.colAiEval")}</span>
            </div>
            {(data?.sessions || []).map((s) => (
              <div key={s.sid} className="border-b border-input/30 py-1.5">
                <div className="grid grid-cols-[8.5rem_5rem_minmax(0,1fr)_5rem_6rem_7rem] items-center gap-x-3 text-[11px]">
                  <span className="font-medium tabular-nums">{s.t0}</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {s.dur_min >= 60
                      ? t("journal.durHourMin", { h: Math.floor(s.dur_min / 60), min: s.dur_min % 60 })
                      : t("journal.durMinutes", { count: s.dur_min })}
                  </span>
                  <span className="truncate text-muted-foreground" title={s.model}>
                    {s.model}
                  </span>
                  <span className="text-right tabular-nums">{fmtKtok(s.tok, millionUnit)}</span>
                  <span className="text-right tabular-nums text-muted-foreground" title={t("journal.colExchReqsTooltip")}>
                    {s.exch} · {s.turns}
                  </span>
                  <div className="flex justify-end">
                    <button
                      className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20"
                      title={t("journal.evaluateSessionTooltip")}
                      onClick={() => onEvaluate({ sid: s.sid, u, display: s.t0 })}
                    >
                      {t("journal.evaluateSession")}
                    </button>
                  </div>
                </div>
                {s.first && (
                  <div className="mt-0.5 line-clamp-2 break-words text-[11px] leading-snug text-muted-foreground">{cleanTxt(s.first)}</div>
                )}
              </div>
            ))}
            {data && !data.sessions.length && <div className="py-4 text-center text-xs text-muted-foreground">{t("journal.noSessions")}</div>}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-input bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t("journal.aiAnalysisUserTitle")}</span>
            <span className="text-[10px] text-muted-foreground">{t("journal.chronicleManual")}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EvalList
              accessToken={accessToken}
              items={evaluations.filter((ev) => ev.targetU === u)}
              empty={t("journal.emptyUserEvaluations")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
