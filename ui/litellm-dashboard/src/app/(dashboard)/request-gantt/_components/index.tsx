"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { apiClient } from "@/components/networking";

interface GanttRowT {
  t0: number;
  t1: number;
  tf: number | null;
  u: string;
  email: string;
  display: string;
  model: string;
  p: number;
  c: number;
  status: string;
  cache_hit: string;
  key_alias: string;
  key_short: string;
}

interface GanttInflightT {
  t0: number;
  t1: number | null;
  u: string;
  display: string;
  model: string;
  key_alias: string;
  key_short: string;
}

interface GanttResponse {
  window?: number;
  from?: number;
  to?: number;
  max_rows: number;
  total: number;
  rows: GanttRowT[];
  inflight?: GanttInflightT[];
}

const WINDOWS = [
  { sec: 900, labelKey: "requestGantt.win15min" },
  { sec: 3600, labelKey: "requestGantt.win1hour" },
  { sec: 21600, labelKey: "requestGantt.win6hours" },
  { sec: 86400, labelKey: "requestGantt.win24hours" },
] as const;

const PALETTE = [
  "#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#475569",
];
const MAX_SHOWN = 150;
const REFRESH_MS = 5000;

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// модель нормализуется: failed-запросы пишутся в SpendLogs без провайдер-префикса,
// без нормализации группа одного человека рвётся на две строки
const normModel = (m: string) => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);

function spanLabel(a: number, b: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const da = new Date(a);
  const db = new Date(b);
  const hm = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (da.toDateString() === db.toDateString()) return `${hm(da)}–${hm(db)}`;
  return `${p(da.getDate())}.${p(da.getMonth() + 1)} ${hm(da)} – ${p(db.getDate())}.${p(db.getMonth() + 1)} ${hm(db)}`;
}

export default function RequestGantt({ accessToken }: { accessToken: string | null }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [windowSec, setWindowSec] = useState(3600);
  const [data, setData] = useState<GanttResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [grouped, setGrouped] = useState(true);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [custom, setCustom] = useState<[number, number] | null>(null);
  const [cform, setCform] = useState(false);
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const chartRef = useRef<HTMLDivElement | null>(null);
  const geomRef = useRef<{ tmin: number; tmax: number; L: number; plotW: number; viewW: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const lastOk = useRef<number>(0);

  const fnum = useCallback((n: number): string => n.toLocaleString(locale), [locale]);
  const fmtTime = useCallback(
    (ms: number): string => new Date(ms).toLocaleTimeString(locale, { hour12: false }),
    [locale],
  );
  const fmtAxis = useCallback(
    (ms: number, spanMs: number): string => {
      const opts: Intl.DateTimeFormatOptions =
        spanMs < 180000
          ? { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 1 }
          : { hour12: false };
      return new Date(ms).toLocaleTimeString(locale, opts);
    },
    [locale],
  );

  const toggleUser = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await apiClient.get<GanttResponse>("/gantt", {
        accessToken,
        query: custom ? { from: custom[0], to: custom[1] } : { window: windowSec },
      });
      setData(res);
      setError(null);
      lastOk.current = Date.now();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken, windowSec, custom]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const colorMap = useMemo(() => {
    const counts: Record<string, number> = {};
    data?.rows.forEach((r) => {
      counts[r.display] = (counts[r.display] || 0) + 1;
    });
    const m: Record<string, string> = {};
    Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
      .forEach((k, i) => {
        m[k] = PALETTE[i % PALETTE.length];
      });
    return m;
  }, [data]);
  const colorOf = useCallback((n: string) => colorMap[n] ?? "#64748b", [colorMap]);

  const chips = useMemo(() => {
    if (!data) return [];
    const acc: Record<string, { n: number; tok: number; color: string }> = {};
    data.rows.forEach((r) => {
      const k = r.display;
      acc[k] = acc[k] || { n: 0, tok: 0, color: colorOf(k) };
      acc[k].n += 1;
      acc[k].tok += (r.p || 0) + (r.c || 0);
    });
    return Object.entries(acc).sort((a, b) => b[1].n - a[1].n);
  }, [data, colorOf]);

  const svg = useMemo(() => {
    geomRef.current = null;
    if (!data || (!data.rows.length && !(data.inflight ?? []).length)) return null;
    const byUser = selected.length ? data.rows.filter((r) => selected.includes(r.display)) : data.rows;
    const all = zoom ? byUser.filter((r) => r.t1 >= zoom[0] && r.t0 <= zoom[1]) : byUser;
    type Line = { who: string; model: string; key: string; items: GanttRowT[]; live: GanttInflightT[] };
    const keyOf = (r: GanttRowT) => r.key_alias || (r.key_short ? `key ${r.key_short}` : "");
    const inflAll = data.inflight ?? [];
    let lines: Line[];
    if (grouped) {
      // строка = дорожка группы чело·модель·ключ; новая строка только при реальном
      // пересечении по времени (упаковка интервалов, без порога разрыва).
      const groups: Record<string, GanttRowT[]> = {};
      all.forEach((r) => {
        const k = `${r.display}|${normModel(r.model)}|${keyOf(r)}`;
        (groups[k] = groups[k] || []).push(r);
      });
      const rowsOut: { line: Line; lastEnd: number; tmax: number }[] = [];
      Object.entries(groups).forEach(([k, arr]) => {
        const parts = k.split("|");
        const who = parts[0];
        const model = parts[1];
        const sorted = arr.slice().sort((a, b) => a.t0 - b.t0);
        const lanes: { line: Line; lastEnd: number; tmax: number }[] = [];
        sorted.forEach((r) => {
          let best = -1;
          let bestEnd = -Infinity;
          lanes.forEach((row, ix) => {
            if (row.lastEnd <= r.t0 && row.lastEnd > bestEnd) {
              best = ix;
              bestEnd = row.lastEnd;
            }
          });
          if (best >= 0) {
            const row = lanes[best];
            row.line.items.push(r);
            row.lastEnd = Math.max(row.lastEnd, r.t1);
            row.tmax = Math.max(row.tmax, r.t1);
          } else {
            const row = { line: { who, model, key: keyOf(r), items: [r], live: [] }, lastEnd: r.t1, tmax: r.t1 };
            lanes.push(row);
            rowsOut.push(row);
          }
        });
      });
      rowsOut.sort((a, b) => b.tmax - a.tmax);
      lines = rowsOut.slice(0, MAX_SHOWN).map((x) => x.line);
    } else {
      lines = all
        .slice(0, MAX_SHOWN)
        .map((r) => ({ who: r.display, model: r.model, key: keyOf(r), items: [r], live: [] }));
    }
    let tmin: number;
    let tmax: number;
    if (zoom) {
      tmin = zoom[0];
      tmax = zoom[1];
    } else if (custom) {
      tmin = custom[0];
      tmax = custom[1];
    } else {
      const rowT0 = lines.map((l) => Math.min(...l.items.map((r) => r.t0)));
      const rowT1 = lines.map((l) => Math.max(...l.items.map((r) => r.t1)));
      const infT0 = inflAll.map((i) => i.t0);
      tmin = Math.min(...(rowT0.length ? rowT0 : infT0));
      tmax = Math.max(...(rowT1.length ? rowT1 : [0]), ...(infT0.length ? infT0 : [0]), Date.now());
    }
    const pad = (tmax - tmin) * 0.04 + 1;
    tmin -= pad;
    tmax += pad;
    // in-flight: приклеиваем к существующей дорожке (grouped), иначе — новая сверху
    const infl = inflAll.filter(
      (i) => i.t0 >= tmin && i.t0 <= tmax && (!selected.length || selected.includes(i.display)),
    );
    if (infl.length) {
      const idx = new Map<string, Line>();
      if (grouped) lines.forEach((l) => idx.set(`${l.who}|${normModel(l.model)}|${l.key}`, l));
      const extra: Line[] = [];
      infl.forEach((i) => {
        const key = i.key_alias || (i.key_short ? `key ${i.key_short}` : "");
        let lane = grouped ? idx.get(`${i.display}|${normModel(i.model)}|${key}`) : undefined;
        if (grouped && !lane) {
          // алиас может быть префиксом разыменённого имени deployment'а (или наоборот)
          const nm = normModel(i.model);
          lane =
            lines.find(
              (l) => l.who === i.display && l.key === key && (normModel(l.model).startsWith(nm) || nm.startsWith(normModel(l.model))),
            ) ?? extra.find(
              (l) => l.who === i.display && l.key === key && (normModel(l.model).startsWith(nm) || nm.startsWith(normModel(l.model))),
            );
        }
        if (lane) lane.live.push(i);
        else extra.push({ who: i.display, model: i.model, key, items: [], live: [i] });
      });
      extra.sort((a, b) => (b.live[0]?.t0 ?? 0) - (a.live[0]?.t0 ?? 0));
      lines = [...extra, ...lines];
    }
    if (!lines.length) return null;
    const L = 250;
    const R = 48;
    const T = 26;
    const ROW_H = 26;
    const BH = 14;
    const GAP = 6;
    const width = 1000;
    const plotW = width - L - R;
    const height = T + lines.length * (ROW_H + GAP) + 14;
    const X = (t: number) => L + ((t - tmin) / (tmax - tmin)) * plotW;
    geomRef.current = { tmin, tmax, L, plotW, viewW: width };

    const grid: string[] = [];
    for (let g = 0; g <= 8; g += 1) {
      const gt = tmin + ((tmax - tmin) * g) / 8;
      const x = X(gt);
      grid.push(`<line x1="${x}" y1="${T - 6}" x2="${x}" y2="${height - 8}" stroke="var(--border)"/>`);
      grid.push(
        `<text x="${x}" y="${T - 10}" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">${fmtAxis(gt, tmax - tmin)}</text>`,
      );
    }
    const nowMs = Date.now();
    if (nowMs >= tmin && nowMs <= tmax) {
      grid.push(
        `<line x1="${X(nowMs)}" y1="${T - 6}" x2="${X(nowMs)}" y2="${height - 8}" stroke="#ef4444" stroke-dasharray="3 3"/>`,
      );
    }

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const bars = lines.map((l, i) => {
      const y = T + i * (ROW_H + GAP);
      const barY = y + (ROW_H - BH) / 2;
      const modelShort = l.model.replace(/^openai\//, "");
      const line1 = cut(l.key ? `${l.who} · ${l.key}` : l.who, 34);
      const running = l.live.filter((iv) => iv.t1 == null).length;
      const liveSuffix = running ? ` · live${running > 1 ? `×${running}` : ""}` : "";
      const line2 = cut(modelShort, 40) + (l.items.length > 1 ? ` ×${l.items.length}` : "") + liveSuffix;
      const col = colorOf(l.who);
      const totTok = l.items.reduce((a, r) => a + (r.p || 0) + (r.c || 0), 0);
      const keyLine = t("requestGantt.tipKey", { key: l.key || t("requestGantt.tipKeyUnnamed") });
      const rowTipRaw = l.items.length
        ? t("requestGantt.rowTipDone", {
            who: l.who,
            model: l.model,
            keyLine,
            requests: l.items.length,
            tokens: fnum(totTok),
            from: fmtTime(l.items[0].t0),
            to: fmtTime(Math.max(...l.items.map((r) => r.t1))),
          })
        : t("requestGantt.rowTipLive", { who: l.who, model: l.model, keyLine, running: l.live.length });
      const rowTipAttr = rowTipRaw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
      let el =
        `<g data-tip="${rowTipAttr}">` +
        `<text x="6" y="${y + 11}" text-anchor="start" font-size="11" font-weight="600" fill="var(--foreground)">${esc(line1)}</text>` +
        `<text x="6" y="${y + 23}" text-anchor="start" font-size="9.5" fill="var(--muted-foreground)">${esc(line2)}</text>` +
        `</g>`;
      l.items.forEach((r) => {
        const dur = (r.t1 - r.t0) / 1000;
        const ttft = r.tf ? (r.tf - r.t0) / 1000 : null;
        const gen = r.c && r.tf ? r.c / Math.max((r.t1 - r.tf) / 1000, 0.001) : 0;
        const tipTxt =
          `${l.who} · ${r.model}\n` +
          t("requestGantt.barTipStart", { time: fmtTime(r.t0), dur: dur.toFixed(2) }) +
          "\n" +
          (ttft != null ? t("requestGantt.barTipTtft", { ttft: ttft.toFixed(2) }) + "\n" : "") +
          t("requestGantt.barTipTokens", { p: fnum(r.p), c: fnum(r.c), rate: gen ? ` (${gen.toFixed(0)} tok/s)` : "" }) +
          (r.key_alias ? `\n${t("requestGantt.tipKey", { key: r.key_alias })}` : r.key_short ? `\n${t("requestGantt.tipKeyHash", { hash: `${r.key_short}…` })}` : "") +
          (l.items.length > 1 ? `\n${t("requestGantt.barTipLane", { index: l.items.indexOf(r) + 1, total: l.items.length })}` : "") +
          (r.status && r.status !== "success" ? `\n${t("requestGantt.barTipStatus", { status: r.status })}` : "");
        const tipTxtEsc = tipTxt.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const tipAttr = tipTxt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
        const x0 = X(r.t0);
        const x1 = Math.max(X(r.t1), x0 + 1.5);
        el += `<g data-tip="${tipAttr}"><title>${tipTxtEsc}</title>`;
        if (r.tf && r.tf > r.t0 && r.tf < r.t1) {
          const xf = X(r.tf);
          el += `<rect x="${x0}" y="${barY}" width="${Math.max(xf - x0, 1)}" height="${BH}" fill="var(--muted-foreground)" opacity="0.35" rx="2"/>`;
          el += `<rect x="${xf}" y="${barY}" width="${Math.max(x1 - xf, 1)}" height="${BH}" fill="${col}" rx="2"/>`;
        } else {
          el += `<rect x="${x0}" y="${barY}" width="${x1 - x0}" height="${BH}" fill="${r.c ? col : "var(--muted-foreground)"}"${r.c ? "" : ' opacity="0.35"'} rx="2"/>`;
        }
        el += "</g>";
      });
      l.live.forEach((iv) => {
        const finished = iv.t1 != null;
        const secs = Math.max(((finished ? iv.t1! : Date.now()) - iv.t0) / 1000, 0);
        const x0 = X(iv.t0);
        const x1 = Math.max(X(Math.min(finished ? iv.t1! : Date.now(), tmax)), x0 + 2);
        const ltip =
          `${l.who}\n` +
          (finished
            ? t("requestGantt.liveTipFinished", { secs: secs.toFixed(1) })
            : t("requestGantt.liveTipRunning", { secs: secs.toFixed(0) })) +
          `\n${t("requestGantt.tipModel", { model: iv.model })}` +
          (iv.key_alias ? `\n${t("requestGantt.tipKey", { key: iv.key_alias })}` : iv.key_short ? `\n${t("requestGantt.tipKeyHash", { hash: `${iv.key_short}…` })}` : "");
        const ltipAttr = ltip.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
        el +=
          `<g data-tip="${ltipAttr}"><title>${ltip.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>` +
          `<rect x="${x0}" y="${barY}" width="${x1 - x0}" height="${BH}" fill="${col}" rx="2" opacity="${finished ? 0.75 : 0.45}">` +
          (finished ? "" : `<animate attributeName="opacity" values="0.25;0.55;0.25" dur="1.6s" repeatCount="indefinite"/>`) +
          `</rect></g>`;
      });
      return el;
    });

    return (
      `<svg viewBox="0 0 ${width} ${height}" ` +
      'style="width:100%;background:var(--background);border:1px solid var(--border);border-radius:8px">' +
      `${grid.join("")}${bars.join("")}</svg>`
    );
  }, [data, colorOf, selected, grouped, windowSec, zoom, custom, t, locale, fnum, fmtTime, fmtAxis]);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return undefined;
    const show = (e: MouseEvent) => {
      const target = (e.target as Element).closest("[data-tip]");
      if (target) setTip({ x: e.clientX + 14, y: e.clientY + 16, text: target.getAttribute("data-tip") || "" });
      else setTip(null);
    };
    el.addEventListener("mouseover", show);
    el.addEventListener("mousemove", show);
    el.addEventListener("mouseout", () => setTip(null));
    let ovl: HTMLDivElement | null = null;
    const clientToT = (cx: number): number | null => {
      const g = geomRef.current;
      const svgEl = el.querySelector("svg");
      if (!g || !svgEl) return null;
      const r = svgEl.getBoundingClientRect();
      const xv = (cx - r.left) * (g.viewW / r.width);
      return g.tmin + ((xv - g.L) / g.plotW) * (g.tmax - g.tmin);
    };
    let dragX0: { x: number; t: number | null } | null = null;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !geomRef.current) return;
      dragX0 = { x: e.clientX, t: clientToT(e.clientX) };
      e.preventDefault();
      const move = (ev: MouseEvent) => {
        if (!dragX0) return;
        const rect = el.getBoundingClientRect();
        const x0 = Math.min(dragX0.x, ev.clientX);
        const x1 = Math.max(dragX0.x, ev.clientX);
        if (!ovl) {
          ovl = document.createElement("div");
          ovl.style.cssText =
            "position:absolute;top:0;bottom:0;background:rgba(37,99,235,.18);border-left:1px solid #2563eb;border-right:1px solid #2563eb;pointer-events:none";
          el.appendChild(ovl);
        }
        ovl.style.left = `${x0 - rect.left}px`;
        ovl.style.width = `${x1 - x0}px`;
      };
      const up = (ev: MouseEvent) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        if (ovl) {
          ovl.remove();
          ovl = null;
        }
        if (!dragX0) return;
        const t1 = dragX0.t;
        const t2 = clientToT(ev.clientX);
        dragX0 = null;
        if (t1 != null && t2 != null && Math.abs(t2 - t1) >= 1000) {
          let a = Math.min(t1, t2);
          let b = Math.max(t1, t2);
          if (custom) {
            a = Math.max(a, custom[0]);
            b = Math.min(b, custom[1]);
            if (b - a < 1000) return;
          }
          setZoom([a, b]);
        }
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    const onDbl = () => setZoom(null);
    el.addEventListener("mousedown", onDown);
    el.addEventListener("dblclick", onDbl);
    return () => {
      el.removeEventListener("mouseover", show);
      el.removeEventListener("mousemove", show);
      el.removeEventListener("mouseout", () => setTip(null));
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("dblclick", onDbl);
    };
  }, [svg, custom]);

  return (
    <div className="space-y-3 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("requestGantt.windowLabel")}</span>
        {WINDOWS.map((w) => (
          <button
            key={w.sec}
            type="button"
            onClick={() => {
              setWindowSec(w.sec);
              setZoom(null);
              setCustom(null);
              setCform(false);
            }}
            className={`rounded border px-2.5 py-1 text-sm ${
              !custom && windowSec === w.sec
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
          >
            {t(w.labelKey)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const from = custom ? new Date((zoom || custom)[0]) : new Date(Date.now() - 3600000);
            const to = custom ? new Date((zoom || custom)[1]) : new Date();
            setCfrom(toLocalInput(from));
            setCto(toLocalInput(to));
            setCform((v) => !v);
          }}
          title={t("requestGantt.customRangeTooltip")}
          className={`rounded border px-2.5 py-1 text-sm ${
            custom
              ? "border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400"
              : "border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
          }`}
        >
          {custom ? spanLabel((zoom || custom)[0], (zoom || custom)[1]) : t("requestGantt.customRange")}
        </button>
        {cform && (
          <span className="flex items-center gap-1.5">
            <input
              type="datetime-local"
              step={1}
              value={cfrom}
              onChange={(e) => setCfrom(e.target.value)}
              className="rounded border border-input bg-background px-1.5 py-0.5 text-sm"
            />
            <span className="text-muted-foreground">—</span>
            <input
              type="datetime-local"
              step={1}
              value={cto}
              onChange={(e) => setCto(e.target.value)}
              className="rounded border border-input bg-background px-1.5 py-0.5 text-sm"
            />
            <button
              type="button"
              onClick={() => {
                const f = Date.parse(cfrom);
                const to = Date.parse(cto);
                if (Number.isNaN(f) || Number.isNaN(to) || to <= f) return;
                setCustom([f, to]);
                setZoom(null);
                setCform(false);
              }}
              className="rounded border border-blue-600 bg-blue-600 px-2 py-0.5 text-sm text-white"
            >
              {t("requestGantt.ok")}
            </button>
            <button
              type="button"
              onClick={() => setCform(false)}
              className="rounded border border-input px-2 py-0.5 text-sm text-muted-foreground hover:bg-accent"
            >
              {t("requestGantt.cancel")}
            </button>
          </span>
        )}
        {zoom && (
          <button
            type="button"
            onClick={() => setZoom(null)}
            title={t("requestGantt.resetZoomTooltip")}
            className="rounded border border-input bg-background px-2.5 py-1 text-sm text-foreground hover:bg-accent"
          >
            ⤺ {t("requestGantt.resetZoom")}
          </button>
        )}
        <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          {t("requestGantt.grouped")}
        </label>
        {data && (
          <span className="ml-auto text-sm text-muted-foreground">
            {selected.length ? `${t("requestGantt.selectedPrefix")}: ` : `${t("requestGantt.requestsPrefix")}: `}
            {selected.length
              ? t("requestGantt.selectedOfTotal", {
                  selected: data.rows.filter((r) => selected.includes(r.display)).length,
                  total: data.total,
                })
              : data.total}
            {(selected.length
              ? data.rows.filter((r) => selected.includes(r.display)).length
              : data.rows.length) > MAX_SHOWN
              ? ` (${t("requestGantt.lastShown", { count: MAX_SHOWN })})`
              : ""}
            {data.inflight?.some((i) => i.t1 == null)
              ? ` · ${t("requestGantt.runningCount", { count: data.inflight.filter((i) => i.t1 == null).length })}`
              : ""}
          </span>
        )}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="text-xs text-muted-foreground">{t("requestGantt.filterByPeople")}</span>
          {chips.map(([name, v]) => {
            const on = selected.includes(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleUser(name)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 transition ${
                  on
                    ? "border-blue-600 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : selected.length
                      ? "border-border bg-background text-muted-foreground/60 hover:bg-accent"
                      : "border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: v.color }} />
                {name}: {v.n} · {fnum(v.tok)} {t("requestGantt.tokensUnit")}
                {on && <span className="ml-0.5 text-blue-600">✓</span>}
              </button>
            );
          })}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected([])}
              className="rounded border border-input px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            >
              {t("requestGantt.clearFilter")}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="text-sm text-destructive">
          {t("requestGantt.loadError")}: {error}
        </div>
      )}
      {typeof svg === "string" ? (
        <div ref={chartRef} className="relative cursor-crosshair" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        !error && (
          <div className="text-sm text-muted-foreground">
            {zoom || custom
              ? t("requestGantt.emptyRange")
              : selected.length
                ? t("requestGantt.emptySelected")
                : t("requestGantt.emptyWindow")}
          </div>
        )
      )}
      {tip && (
        <div
          className="pointer-events-none fixed z-50 max-w-[480px] whitespace-pre-line rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg"
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}
