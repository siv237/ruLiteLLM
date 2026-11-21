"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { apiClient } from "@/components/networking";

interface InflightT {
  id?: string;
  t0: number;
  t1: number | null;
  tf: number | null;
  ntok: number;
  stream: boolean;
  u: string;
  display: string;
  model: string;
  alias?: string;
  key_alias: string;
  key_short: string;
  elapsed_ms: number;
  ttft_ms: number | null;
  tok_s: number;
  nchars?: number;
  aborted?: boolean;
}

interface RecentT {
  t0: number;
  t1: number | null;
  tf: number | null;
  u: string;
  display: string;
  key_alias?: string;
  key_short?: string;
  model: string;
  alias?: string;
  ip?: string;
  agent?: string;
  p: number;
  c: number;
  status: string;
  duration_ms: number | null;
  tok_s: number;
  prefill_tok_s: number;
}

interface ModelStateT {
  name: string;
  deployments: number;
  max_input_tokens: number | null;
  cooldown_sec: number;
  state: string;
}

interface CountersT {
  uptime_sec: number;
  requests: number;
  success: number;
  failure: number;
  stream: number;
  prompt_tokens: number;
  completion_tokens: number;
  prefill_peak_tok_s: number;
  gen_peak_tok_s: number;
}

interface StateResponse {
  now: number;
  counters: CountersT;
  state: string;
  inflight: InflightT[];
  recent: RecentT[];
  models: ModelStateT[];
  prefill?: { window_sec: number; series: number[] };
  gen?: { window_sec: number; series: number[] };
}

const REFRESH_MS = 2000;
const COOL_WINDOW_SEC = 3600;

const normModel = (m: string) => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);

// запасной оттенок из хэша (обычно не нужен — основной расклад ниже)
function pairHue(model: string, keyAlias: string, keyShort: string): number {
  const s = `${model}\u0000${keyAlias || keyShort}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.round(((h >>> 0) * 137.508) % 360);
}

const hueStyle = (hue: number) => ({ "--ph": String(hue) }) as CSSProperties;
const CHIP_CLS =
  "border-[hsl(var(--ph)_60%_50%/0.6)] bg-[hsl(var(--ph)_60%_50%/0.1)] text-[hsl(var(--ph)_60%_35%)] dark:text-[hsl(var(--ph)_75%_72%)]";
const ROW_CLS = "bg-[hsl(var(--ph)_65%_50%/0.09)]";
const SEL_ROW_CLS = "bg-[hsl(var(--ph)_65%_50%/0.28)]";
const DIM_CLS = "opacity-40";

// идентификатор связки «пользователь+модель+ключ» для подсветки по клику
const pairId = (u: string, model: string, keyAlias: string, keyShort: string) =>
  `${u}\u0000${normModel(model)}\u0000${keyAlias || keyShort}`;
const TEXT_CLS = "text-[hsl(var(--ph)_60%_35%)] dark:text-[hsl(var(--ph)_75%_72%)]";

interface PairStatT {
  u: string;
  display: string;
  model: string;
  alias: string;
  key_alias: string;
  key_short: string;
  count: number;
  cooldown: number;
  deployments: number;
  max_input: number | null;
}

interface InflightGroupT {
  u: string;
  display: string;
  model: string;
  alias: string;
  key_alias: string;
  key_short: string;
  ids: string[];
  count: number;
  stream: boolean;
  elapsed_ms: number;
  ttft_ms: number | null;
  ntok: number;
  tok_s: number;
}

// группировка одинаковых (пользователь+модель+ключ) in-flight с счётчиком параллельности:
// «Идёт» = самый старый запрос группы, TTFT = лучший, токены/скорость = сумма по группе
function groupInflight(items: InflightT[]): InflightGroupT[] {
  const map = new Map<string, InflightGroupT>();
  for (const e of items) {
    const gk = `${e.u}\u0000${e.model}\u0000${e.key_alias || e.key_short}`;
    const g = map.get(gk);
    if (!g) {
      map.set(gk, {
        u: e.u,
        display: e.display,
        model: e.model,
        alias: e.alias || e.model,
        key_alias: e.key_alias,
        key_short: e.key_short,
        ids: e.id ? [e.id] : [],
        count: 1,
        stream: e.stream,
        elapsed_ms: e.elapsed_ms,
        ttft_ms: e.ttft_ms,
        ntok: e.ntok,
        tok_s: e.tok_s,
      });
    } else {
      g.count += 1;
      if (e.id) g.ids.push(e.id);
      g.elapsed_ms = Math.max(g.elapsed_ms, e.elapsed_ms);
      g.ntok += e.ntok;
      g.tok_s += e.tok_s;
      if (e.stream) g.stream = true;
      if (e.ttft_ms != null) g.ttft_ms = g.ttft_ms == null ? e.ttft_ms : Math.min(g.ttft_ms, e.ttft_ms);
    }
  }
  return [...map.values()].sort((a, b) => b.tok_s - a.tok_s || b.count - a.count || b.elapsed_ms - a.elapsed_ms);
}

function KeyCell({ alias, short }: { alias: string; short: string }) {
  const { t } = useTranslation();
  if (!alias && !short) return <span>{t("monitoring.noData")}</span>;
  return (
    <span className="font-mono" title={alias ? `${alias} · ${short}` : short}>
      {alias || short.slice(0, 8)}
    </span>
  );
}

function Sparkline({ values, color = "blue" }: { values: number[]; color?: "blue" | "violet" }) {
  const { t } = useTranslation();
  const W = 300;
  const H = 56;
  if (values.length < 2) {
    return <div className="text-xs text-muted-foreground">{t("monitoring.accumulatingHistory")}</div>;
  }
  // прореживание длинной истории (60 мин) до ~300 точек графика
  const values2 =
    values.length > 300
      ? Array.from({ length: 300 }, (_, j) => values[Math.floor((j * (values.length - 1)) / 299)])
      : values;
  const maxTok = Math.max(...values2, 1);
  const step = W / (values2.length - 1);
  const path = values2
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(H - (v / maxTok) * (H - 6) - 3).toFixed(1)}`)
    .join(" ");
  const fillCls = color === "violet" ? "text-violet-500" : "text-blue-500";
  const lineCls = color === "violet" ? "text-violet-600 dark:text-violet-400" : "text-blue-600 dark:text-blue-400";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full">
      <path d={`${path} L${W},${H} L0,${H} Z`} fill="currentColor" opacity={0.12} className={fillCls} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className={lineCls} />
    </svg>
  );
}

export default function Monitoring({ accessToken }: { accessToken: string | null }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // клик по чипсу выделяет его строки, повторный клик — сброс
  const [selPair, setSelPair] = useState<string | null>(null);
  // модалка «подробно»: ключ группы (u+модель+ключ), сессии берутся из живых данных
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [abortBusy, setAbortBusy] = useState(false);
  const [abortErr, setAbortErr] = useState<string | null>(null);

  const fmtKtok = useCallback(
    (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
    [],
  );
  const fnum = useCallback((n: number): string => n.toLocaleString(locale), [locale]);
  const fmtTime = useCallback(
    (ms: number): string => new Date(ms).toLocaleTimeString(locale, { hour12: false }),
    [locale],
  );
  const fmtDur = useCallback(
    (ms: number | null): string => {
      if (ms == null) return t("monitoring.noData");
      const s = ms / 1000;
      if (s < 60) return t("monitoring.durSec", { count: Math.round(s * 10) / 10 });
      if (s < 3600) return t("monitoring.durMinSec", { min: Math.floor(s / 60), sec: Math.round(s % 60) });
      return t("monitoring.durHourMin", { h: Math.floor(s / 3600), min: Math.floor((s % 3600) / 60) });
    },
    [t],
  );
  const fmtUptime = useCallback(
    (sec: number): string => {
      if (sec < 3600) return t("monitoring.durMinutes", { count: Math.floor(sec / 60) });
      if (sec < 86400) return t("monitoring.durHourMin", { h: Math.floor(sec / 3600), min: Math.floor((sec % 3600) / 60) });
      return t("monitoring.durDaysHours", { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) });
    },
    [t],
  );

  // суммарное время в кулдауне за окно 60 мин: по каждому опросу засчитываем паузу
  // между опросами моделям, бывшим в кулдауне (накапливается, пока открыта страница)
  const coolRef = useRef<{ last: number; spans: Map<string, Array<[number, number]>> }>({ last: 0, spans: new Map() });

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await apiClient.get<StateResponse>("/dashboard/state", { accessToken });
      setData(res);
      setError(null);
      const now = Date.now();
      const cr = coolRef.current;
      const dt = cr.last ? Math.min((now - cr.last) / 1000, 15) : 0;
      cr.last = now;
      if (dt > 0) {
        for (const m of res.models || []) {
          if (m.cooldown_sec > 0) {
            const k = normModel(m.name);
            const arr = cr.spans.get(k) || [];
            arr.push([now, dt]);
            cr.spans.set(k, arr);
          }
        }
      }
      for (const [k, arr] of cr.spans) {
        const kept = arr.filter(([ts]) => now - ts <= COOL_WINDOW_SEC * 1000);
        if (kept.length) cr.spans.set(k, kept);
        else cr.spans.delete(k);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const groupKeyOf = (e: InflightT) => `${e.u}\u0000${e.model}\u0000${e.key_alias || e.key_short}`;

  const abortSessions = useCallback(
    async (ids: string[]) => {
      if (!accessToken || ids.length === 0) return;
      setAbortBusy(true);
      setAbortErr(null);
      try {
        await apiClient.post("/dashboard/abort", { accessToken, body: { ids } });
        await load();
      } catch (e) {
        setAbortErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAbortBusy(false);
      }
    },
    [accessToken, load],
  );

  const detailSessions = detailKey ? (data?.inflight || []).filter((e) => groupKeyOf(e) === detailKey) : [];

  const liveTok = data ? data.inflight.reduce((a, e) => a + (e.tok_s || 0), 0) : 0;
  const genSeries = data?.gen?.series || [];
  const counters = data?.counters;
  const prefillSeries = data?.prefill?.series || [];
  // суммы токенов завершённых запросов за окно (60 мин) — монотонно растут
  const prefillSum = (data?.recent || []).reduce((a, r) => a + (r.p || 0), 0);
  const genSum = (data?.recent || []).reduce((a, r) => a + (r.c || 0), 0);
  const groups = data ? groupInflight(data.inflight) : [];

  // чипы: пары «модель · ключ» только для реально вызывавшихся в окне отчёта
  // (in-flight + recent), порядок по числу вызовов; кулдауны/deployment'ы — из роутера
  const pairStats = new Map<string, PairStatT>();
  const bump = (u: string, display: string, m: string, alias: string, ka: string, ks: string) => {
    const model = normModel(m);
    const k = pairId(u, m, ka, ks);
    const st = pairStats.get(k);
    if (st) st.count += 1;
    else
      pairStats.set(k, {
        u,
        display,
        model,
        alias: alias || m,
        key_alias: ka,
        key_short: ks,
        count: 1,
        cooldown: 0,
        deployments: 0,
        max_input: null,
      });
  };
  for (const e of data?.inflight || []) bump(e.u, e.display, e.model, e.alias || "", e.key_alias, e.key_short);
  for (const r of data?.recent || []) bump(r.u, r.display, r.model, r.alias || "", r.key_alias || "", r.key_short || "");
  const routerState = new Map<string, ModelStateT>();
  for (const m of data?.models || []) routerState.set(normModel(m.name), m);
  for (const st of pairStats.values()) {
    // кулдауны роутер знает по алиасу — ищем по нему, иначе по имени модели
    const ms = routerState.get(normModel(st.alias)) || routerState.get(st.model);
    if (ms) {
      st.cooldown = ms.cooldown_sec;
      st.deployments = ms.deployments;
      st.max_input = ms.max_input_tokens;
    }
  }
  const usedPairs = [...pairStats.values()].sort(
    (a, b) => b.count - a.count || a.model.localeCompare(b.model) || a.key_alias.localeCompare(b.key_alias),
  );
  // доминирующий цвет = ПОЛЬЗОВАТЕЛЬ (соседние юзеры разнесены на золотой угол
  // 137.5°), а каждая пара «модель+ключ» внутри юзера сдвигается на ±24/±48° —
  // семейство цвета читается, пары различаются; порядок стабилен в сессии
  const usersSorted = [...new Set([...pairStats.values()].map((s) => s.u))].sort();
  const baseHue = new Map(usersSorted.map((u, i) => [u, Math.round((i * 137.508) % 360)]));
  const OFFSETS = [0, 24, -24, 48, -48];
  const keysByUser = new Map<string, string[]>();
  for (const k of [...pairStats.keys()].sort()) {
    const u = k.split("\u0000")[0];
    const arr = keysByUser.get(u) || [];
    arr.push(k);
    keysByUser.set(u, arr);
  }
  const hueByPair = new Map<string, number>();
  for (const [u, keys] of keysByUser) {
    const base = baseHue.get(u) ?? 0;
    keys.forEach((k, i) => hueByPair.set(k, (((base + OFFSETS[i % OFFSETS.length]) % 360) + 360) % 360));
  }

  const stateBadge = () => {
    if (error && !data) return { text: t("monitoring.stateNoConnection"), cls: "bg-red-600 text-white" };
    if (data?.state === "generating")
      return {
        text: t("monitoring.stateGenerating", { count: data.inflight.length }),
        cls: "bg-green-600 text-white animate-pulse",
      };
    return { text: t("monitoring.stateIdle"), cls: "bg-slate-500 text-white" };
  };
  const badge = stateBadge();

  return (
    <div className="flex h-full flex-col gap-3 p-2">
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <span className={`rounded px-3 py-1 text-sm font-semibold ${badge.cls}`}>{badge.text}</span>
        {usedPairs.map((st, i) => {
          const pid = pairId(st.u, st.model, st.key_alias, st.key_short);
          const hue = hueByPair.get(pid) ?? pairHue(st.model, st.key_alias, st.key_short);
          const coolSec = (coolRef.current.spans.get(normModel(st.alias)) || []).reduce((a, [, d]) => a + d, 0);
          const key = st.key_alias || st.key_short.slice(0, 8) || t("monitoring.noData");
          const sel = selPair === pid;
          return (
            <span
              key={`${st.model}-${key}-${i}`}
              style={hueStyle(hue)}
              onClick={() => setSelPair(sel ? null : pid)}
              className={`cursor-pointer rounded border px-2 py-0.5 text-xs ${CHIP_CLS} ${
                sel ? "ring-2 ring-[hsl(var(--ph))]" : selPair ? DIM_CLS : ""
              }`}
              title={t("monitoring.chipTooltip", {
                user: st.display || st.u,
                alias: st.alias,
                calls: st.count,
                deployments: st.deployments ? t("monitoring.chipDeployments", { count: st.deployments }) : "",
                maxInput: st.max_input ? t("monitoring.chipMaxInput", { tokens: fnum(st.max_input) }) : "",
                cooldown: st.cooldown > 0 ? t("monitoring.chipCooldownNow", { sec: Math.ceil(st.cooldown) }) : "",
              })}
            >
              {st.model}
              {st.alias !== st.model ? <span className="opacity-60"> {st.alias}</span> : ""} ·{" "}
              <span className="font-mono">{key}</span>
              {st.count > 1 ? ` · ${st.count}` : ""}
              {coolSec >= 1 ? (
                <span className={`text-amber-600 dark:text-amber-400 ${st.cooldown > 0 ? "animate-pulse" : ""}`}>
                  {" "}
                  · {t("monitoring.chipCooldownTotal", { dur: fmtDur(Math.round(coolSec) * 1000) })}
                </span>
              ) : (
                st.cooldown > 0 && (
                  <span className="animate-pulse text-amber-600 dark:text-amber-400"> · {t("monitoring.cooldown")}</span>
                )
              )}
            </span>
          );
        })}
        {error && data && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {t("monitoring.noConnection")}: {error}
          </span>
        )}
      </div>

      <div className="grid shrink-0 gap-3 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_1.7fr]">
        <div className="rounded border border-input bg-card p-3">
          <div className="mb-1 flex items-start justify-between">
            <span className="text-sm font-medium">{t("monitoring.outgoing")}</span>
            <div className="text-right">
              <div className="text-[10px] text-muted-foreground" title={t("monitoring.outgoingWindowTooltip")}>
                {t("monitoring.lastHourTokens", { tokens: fmtKtok(genSum) })}
              </div>
              <div className="text-2xl font-bold leading-none tabular-nums">{liveTok.toFixed(1)} {t("monitoring.tokPerSec")}</div>
            </div>
          </div>
          <Sparkline values={genSeries} />
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>{t("monitoring.peakSinceStart", { value: fmtKtok(counters?.gen_peak_tok_s || 0) })}</span>
            <span>{t("monitoring.genEstimateNote")}</span>
          </div>
        </div>

        <div className="rounded border border-input bg-card p-3">
          <div className="mb-1 flex items-start justify-between">
            <span className="text-sm font-medium">{t("monitoring.incoming")}</span>
            <div className="text-right">
              <div className="text-[10px] text-muted-foreground" title={t("monitoring.incomingWindowTooltip")}>
                {t("monitoring.lastHourTokens", { tokens: fmtKtok(prefillSum) })}
              </div>
              <div className="text-2xl font-bold leading-none tabular-nums">
                {fmtKtok(prefillSeries[prefillSeries.length - 1] || 0)} {t("monitoring.tokPerSec")}
              </div>
            </div>
          </div>
          {prefillSeries.length >= 2 ? (
            <Sparkline values={prefillSeries} color="violet" />
          ) : (
            <div className="text-xs text-muted-foreground">{t("monitoring.noCompletedRequests")}</div>
          )}
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>{t("monitoring.peakSinceStart", { value: fmtKtok(counters?.prefill_peak_tok_s || 0) })}</span>
            <span>{t("monitoring.prefillNote")}</span>
          </div>
        </div>

        <div className="rounded border border-input bg-card p-3">
          <div className="mb-2 text-sm font-medium">
            {t("monitoring.inflightTitle")}
            {data && data.inflight.length > 0 && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">· {data.inflight.length}</span>
            )}
          </div>
          {groups.length > 0 ? (
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-2 font-normal">{t("monitoring.colUser")}</th>
                  <th className="pr-2 font-normal">{t("monitoring.colKey")}</th>
                  <th className="pr-2 font-normal">{t("monitoring.colModel")}</th>
                  <th className="pr-2 text-right font-normal" title={t("monitoring.colParallelTooltip")}>
                    {t("monitoring.colParallel")}
                  </th>
                  <th className="pr-2 text-right font-normal">{t("monitoring.colElapsed")}</th>
                  <th className="pr-2 text-right font-normal" title={t("monitoring.colFirstResponseTooltip")}>
                    {t("monitoring.colFirstResponse")}
                  </th>
                  <th className="pr-2 text-right font-normal">{t("monitoring.colTokens")}</th>
                  <th className="pr-2 text-right font-normal">{t("monitoring.colTokSec")}</th>
                  <th className="text-right font-normal">{t("monitoring.colAction")}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => {
                  const name = normModel(g.model);
                  const pid = pairId(g.u, name, g.key_alias, g.key_short);
                  const hue = hueByPair.get(pid) ?? pairHue(name, g.key_alias, g.key_short);
                  const rowCls = selPair ? (selPair === pid ? SEL_ROW_CLS : DIM_CLS) : ROW_CLS;
                  return (
                    <tr key={`${g.u}-${g.model}-${i}`} style={hueStyle(hue)} className={`border-t border-input/40 ${rowCls}`}>
                      <td className="max-w-[8rem] truncate py-1 pr-2" title={g.display}>{g.display}</td>
                      <td className="pr-2">
                        <KeyCell alias={g.key_alias} short={g.key_short} />
                      </td>
                      <td
                        className={`max-w-[13rem] truncate pr-2 ${TEXT_CLS}`}
                        title={g.alias !== g.model ? t("monitoring.chipAliasLine", { alias: g.alias }) : name}
                      >
                        {name}
                        {g.alias !== g.model ? <span className="text-muted-foreground"> {g.alias}</span> : ""}
                      </td>
                      <td className="pr-2 text-right tabular-nums">
                        {g.count > 1 ? <b className="text-foreground">×{g.count}</b> : "1"}
                      </td>
                      <td className="pr-2 text-right tabular-nums">{fmtDur(g.elapsed_ms)}</td>
                      <td className="pr-2 text-right tabular-nums">{g.ttft_ms != null ? fmtDur(g.ttft_ms) : "…"}</td>
                      <td className="pr-2 text-right tabular-nums">{g.stream ? fnum(g.ntok) : t("monitoring.noData")}</td>
                      <td className="pr-2 text-right tabular-nums">{g.stream ? g.tok_s.toFixed(1) : t("monitoring.noData")}</td>
                      <td className="text-right">
                        <button
                          onClick={() => {
                            setDetailKey(`${g.u}\u0000${g.model}\u0000${g.key_alias || g.key_short}`);
                            setAbortErr(null);
                          }}
                          className="rounded border border-input px-1.5 py-0.5 text-[10px] hover:bg-accent"
                        >
                          {t("monitoring.details")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-center text-xs text-muted-foreground">{t("monitoring.noActiveRequests")}</div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded border border-input bg-card p-3">
        <div className="mb-2 shrink-0 text-sm font-medium">{t("monitoring.recentTitle")}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left text-muted-foreground">
                <th className="pr-2 font-normal">{t("monitoring.colTime")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colStatus")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colUser")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colKey")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colIp")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colModel")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colAlias")}</th>
                <th className="pr-2 font-normal">{t("monitoring.colAgent")}</th>
                <th className="pr-2 text-right font-normal">{t("monitoring.colPrompt")}</th>
                <th className="pr-2 text-right font-normal">{t("monitoring.colPrefillTokSec")}</th>
                <th className="pr-2 text-right font-normal">{t("monitoring.colCompletion")}</th>
                <th className="pr-2 text-right font-normal">{t("monitoring.colTokSec")}</th>
                <th className="text-right font-normal">{t("monitoring.colDuration")}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent || []).map((r, i) => {
                const name = normModel(r.model);
                const pid = pairId(r.u, name, r.key_alias || "", r.key_short || "");
                const hue = hueByPair.get(pid) ?? pairHue(name, r.key_alias || "", r.key_short || "");
                const rowCls = selPair ? (selPair === pid ? SEL_ROW_CLS : DIM_CLS) : ROW_CLS;
                return (
                  <tr key={`${r.t0}-${i}`} style={hueStyle(hue)} className={`border-t border-input/40 ${rowCls}`}>
                    <td className="py-1 pr-2 tabular-nums">{fmtTime(r.t0)}</td>
                    <td className={`pr-2 ${r.status === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {r.status === "success" ? t("monitoring.statusOk") : r.status === "failure" ? t("monitoring.statusError") : r.status}
                    </td>
                    <td className="max-w-[8rem] truncate pr-2" title={r.display}>{r.display}</td>
                    <td className="pr-2">
                      <KeyCell alias={r.key_alias || ""} short={r.key_short || ""} />
                    </td>
                    <td className="pr-2 font-mono text-muted-foreground" title={r.ip || ""}>{r.ip || t("monitoring.noData")}</td>
                    <td className={`max-w-[13rem] truncate pr-2 ${TEXT_CLS}`} title={name}>{name}</td>
                    <td className="max-w-[11rem] truncate pr-2 text-muted-foreground" title={r.alias || ""}>
                      {r.alias && r.alias !== r.model ? normModel(r.alias) : t("monitoring.noData")}
                    </td>
                    <td className="max-w-[12rem] truncate pr-2 text-muted-foreground" title={r.agent || ""}>
                      {r.agent || t("monitoring.noData")}
                    </td>
                    <td className="pr-2 text-right tabular-nums">{r.p ? fnum(r.p) : t("monitoring.noData")}</td>
                    <td className="pr-2 text-right tabular-nums">{r.prefill_tok_s ? fmtKtok(r.prefill_tok_s) : t("monitoring.noData")}</td>
                    <td className="pr-2 text-right tabular-nums">{r.c ? fnum(r.c) : t("monitoring.noData")}</td>
                    <td className="pr-2 text-right tabular-nums">{r.tok_s ? r.tok_s.toFixed(1) : t("monitoring.noData")}</td>
                    <td className="text-right tabular-nums">{fmtDur(r.duration_ms)}</td>
                  </tr>
                );
              })}
              {(!data || data.recent.length === 0) && (
                <tr>
                  <td colSpan={13} className="py-4 text-center text-muted-foreground">
                    {t("monitoring.noDataLastHour")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detailKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setDetailKey(null)}>
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-input bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="truncate text-sm font-medium">
                {t("monitoring.sessionsTitle", {
                  user: detailSessions[0]?.display || detailKey.split("\u0000")[0] || t("monitoring.noData"),
                  model: detailSessions[0] ? normModel(detailSessions[0].model) : normModel(detailKey.split("\u0000")[1] || ""),
                })}
                <span className="ml-1 text-xs font-normal text-muted-foreground">· {detailSessions.length}</span>
              </div>
              <button
                onClick={() => setDetailKey(null)}
                className="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-accent"
              >
                {t("monitoring.close")}
              </button>
            </div>
            {abortErr && (
              <div className="mb-2 rounded bg-red-600/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">{abortErr}</div>
            )}
            {detailSessions.length > 0 ? (
              <table className="w-full text-xs whitespace-nowrap">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pr-2 font-normal">{t("monitoring.colStarted")}</th>
                    <th className="pr-2 font-normal">{t("monitoring.colElapsed")}</th>
                    <th className="pr-2 font-normal">{t("monitoring.colFirstResponse")}</th>
                    <th className="pr-2 font-normal">{t("monitoring.colStream")}</th>
                    <th className="pr-2 text-right font-normal">{t("monitoring.colTokensEstimate")}</th>
                    <th className="pr-2 text-right font-normal">{t("monitoring.colTokSec")}</th>
                    <th className="pr-2 text-right font-normal">{t("monitoring.colChars")}</th>
                    <th className="pr-2 font-normal">ID</th>
                    <th className="text-right font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {detailSessions.map((s, i) => (
                    <tr key={s.id || `${s.t0}-${i}`} className="border-t border-input/40">
                      <td className="py-1 pr-2 tabular-nums">{fmtTime(s.t0)}</td>
                      <td className="pr-2 tabular-nums">{fmtDur(s.elapsed_ms)}</td>
                      <td className="pr-2 tabular-nums">{s.ttft_ms != null ? fmtDur(s.ttft_ms) : "…"}</td>
                      <td className="pr-2">{s.stream ? t("monitoring.yes") : t("monitoring.no")}</td>
                      <td className="pr-2 text-right tabular-nums">{s.stream ? fnum(s.ntok) : t("monitoring.noData")}</td>
                      <td className="pr-2 text-right tabular-nums">{s.tok_s ? s.tok_s.toFixed(1) : "0.0"}</td>
                      <td className="pr-2 text-right tabular-nums">{fnum(s.nchars || 0)}</td>
                      <td className="pr-2 font-mono text-muted-foreground" title={s.id}>
                        {s.id ? s.id.slice(0, 8) : t("monitoring.noData")}
                      </td>
                      <td className="text-right">
                        <button
                          disabled={abortBusy || !s.id}
                          onClick={() => s.id && abortSessions([s.id])}
                          className="rounded border border-red-500/50 px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-600/10 disabled:opacity-40 dark:text-red-400"
                        >
                          ✕ {t("monitoring.abort")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="py-4 text-center text-xs text-muted-foreground">{t("monitoring.noActiveGroupSessions")}</div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                disabled={abortBusy || detailSessions.length === 0}
                onClick={() => abortSessions(detailSessions.map((s) => s.id).filter((x): x is string => !!x))}
                className="rounded border border-red-500/60 bg-red-600/10 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-600/20 disabled:opacity-40 dark:text-red-300"
              >
                {abortBusy ? t("monitoring.aborting") : t("monitoring.abortAll", { count: detailSessions.length })}
              </button>
            </div>
          </div>
        </div>
      )}

      {counters && (
        <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 rounded border border-input bg-card p-3 text-xs text-muted-foreground">
          <span>{t("monitoring.sinceStart", { uptime: fmtUptime(counters.uptime_sec) })}:</span>
          <span>{t("monitoring.requestsCounter")}: <b className="text-foreground tabular-nums">{fnum(counters.requests)}</b></span>
          <span>{t("monitoring.successCounter")}: <b className="text-foreground tabular-nums">{fnum(counters.success)}</b></span>
          <span>{t("monitoring.failureCounter")}: <b className="text-foreground tabular-nums">{fnum(counters.failure)}</b></span>
          <span>{t("monitoring.promptTokensCounter")}: <b className="text-foreground tabular-nums">{fnum(counters.prompt_tokens)}</b></span>
          <span>{t("monitoring.completionTokensCounter")}: <b className="text-foreground tabular-nums">{fnum(counters.completion_tokens)}</b></span>
        </div>
      )}
    </div>
  );
}
