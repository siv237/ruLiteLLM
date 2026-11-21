// fork: общий слой данных панели «Журнал активности» (admin-only, v1 08.10.2026)

export interface CellT {
  d: string;
  h: number;
  n: number;
  tok: number;
  ppl: number;
}

export interface ParticipantT {
  u: string;
  display: string;
  type: "human" | "system" | "anon";
  reqs: number;
  tok: number;
  sess: number;
  exch: number;
  hours: string;
  models: string;
  t_first: string;
  t_last: string;
}

export interface RecentT {
  u: string;
  sid: string;
  display: string;
  t: string;
  txt: string;
  turns: number;
}

export interface StateResponse {
  days: number;
  tz: string;
  now: number;
  cells: CellT[];
  totals: {
    reqs: number;
    tok: number;
    people: number;
    systems: number;
    participants: number;
    peak_hour: number | null;
    prev_reqs: number;
    prev_tok: number;
    prev_people: number;
  };
  participants: ParticipantT[];
  recent: RecentT[];
  models: string[];
}

export interface SessionT {
  sid: string;
  t0: string;
  t1: string;
  dur_min: number;
  turns: number;
  exch: number;
  tok: number;
  model: string;
  agent: string;
  first: string;
}

export interface UserResponse {
  u: string;
  display: string;
  email: string;
  days: number;
  tz: string;
  totals: { reqs: number; tok: number; sess: number; exch: number };
  daily: { d: string; n: number; tok: number }[];
  top_models: { m: string; n: number; pct: number }[];
  sessions: SessionT[];
  facts: { longest_min: number; top_agent: string };
}

export interface EvaluationT {
  id: number;
  created: string;
  periodDays: number;
  model: string;
  digestChars: number;
  rlen: number;
  error: string;
  targetU?: string;
  targetSid?: string;
  periodFrom?: string;
  periodTo?: string;
  createdBy: string;
  preview: string;
}

export function fnum(n: number, locale: string): string {
  return n.toLocaleString(locale);
}

export function fmtKtok(v: number, millionUnit: string): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} ${millionUnit}`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(0);
}

// стабильный оттенок участнику по рангу (золотой угол — как в Мониторинге)
export function userHues(displays: string[]): Map<string, number> {
  const m = new Map<string, number>();
  [...displays].sort().forEach((d, i) => m.set(d, Math.round((i * 137.508) % 360)));
  return m;
}

export const TYPE_BADGE: Record<string, { labelKey: "journal.typeHuman" | "journal.typeSystem" | "journal.typeAnon"; cls: string }> = {
  human: {
    labelKey: "journal.typeHuman",
    cls: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  system: {
    labelKey: "journal.typeSystem",
    cls: "border-border bg-muted text-muted-foreground",
  },
  anon: {
    labelKey: "journal.typeAnon",
    cls: "border-border bg-muted/50 text-muted-foreground",
  },
};

// «2026-10-09 10:14» (уже местное, UTC+10) → «10:14» сегодня, иначе «10-09 10:14»
export function fmtWhen(t: string, nowMs: number): string {
  const today = new Date(nowMs + 10 * 3600_000).toISOString().slice(0, 10);
  const [d, hm] = t.split(" ");
  if (!hm) return t;
  return d === today ? hm : `${d.slice(5)} ${hm}`;
}

// текст из psr приходит с литеральными «\n» (два символа) — чистим для показа
export function cleanTxt(s: string, multiline = false): string {
  const t = s.replace(/\\r\\n|\\n/g, multiline ? "\n" : " ").replace(/\\t/g, " ");
  return multiline ? t.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : t.replace(/\s+/g, " ").trim();
}

// «2026-10-09 09:22» (Владивосток) + глубина → читабельный диапазон «06.10 09:22 → 09.10 09:22»
export function periodRange(created: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(created);
  if (!m) return "";
  const endMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const f = (x: Date) =>
    `${String(x.getUTCDate()).padStart(2, "0")}.${String(x.getUTCMonth() + 1).padStart(2, "0")} ${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")}`;
  return `${f(new Date(endMs - days * 86400_000))} → ${f(new Date(endMs))}`;
}

// подпись периода оценки: абсолютный период из летописи либо «created-Ndays → created»
export function periodLabel(ev: EvaluationT): string {
  if (ev.periodFrom && ev.periodTo) {
    return `${ev.periodFrom.slice(5, 10)} ${ev.periodFrom.slice(11, 16)} → ${ev.periodTo.slice(5, 10)} ${ev.periodTo.slice(11, 16)}`;
  }
  return periodRange(ev.created, ev.periodDays);
}

export const REPORT_PROSE_CLS =
  "prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed " +
  "[&_h1]:mt-1 [&_h1]:text-lg [&_h2]:mt-5 [&_h2]:mb-1.5 [&_h2]:border-b [&_h2]:border-input/40 [&_h2]:pb-1 [&_h2]:text-base " +
  "[&_h3]:mt-3 [&_h3]:text-[13px] [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 " +
  "[&_table]:my-2 [&_th]:text-[11px] [&_td]:text-[12px] [&_code]:text-[12px]";

export function downloadMd(filename: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function fmtDelta(cur: number, prev: number): { txt: string; up: boolean } | null {
  if (!prev) return null;
  const p = Math.round(((cur - prev) / prev) * 100);
  return { txt: `${p >= 0 ? "↑" : "↓"} ${Math.abs(p)}%`, up: p >= 0 };
}
