"use client";

// fork: тепловая карта «дни × часы» журнала активности (чистый SQL-датасет, без LLM)

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { fmtKtok, fnum, type CellT } from "./shared";

export default function Heatmap({ cells, onCellClick }: { cells: CellT[]; onCellClick?: (c: CellT) => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const millionUnit = t("journal.unitMillion");
  const { days, byDay, max } = useMemo(() => {
    const m = new Map<string, Map<number, CellT>>();
    let mx = 1;
    for (const c of cells) {
      if (!m.has(c.d)) m.set(c.d, new Map());
      m.get(c.d)!.set(c.h, c);
      if (c.n > mx) mx = c.n;
    }
    const ds = [...m.keys()].sort().reverse();
    return { days: ds, byDay: m, max: mx };
  }, [cells]);

  if (!days.length) return <div className="text-xs text-muted-foreground">{t("journal.noPeriodData")}</div>;

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="mb-1 grid grid-cols-[3.2rem_repeat(24,minmax(0,1fr))] gap-[3px] pl-1 text-[9px] text-muted-foreground">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center">
                {h}
              </span>
            ))}
          </div>
          <div className="space-y-[3px]">
            {days.map((d) => (
              <div key={d} className="grid grid-cols-[3.2rem_repeat(24,minmax(0,1fr))] gap-[3px] items-center">
                <span className="pr-1 text-right text-[10px] tabular-nums text-muted-foreground">{d.slice(5)}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = byDay.get(d)?.get(h);
                  const a = c ? 0.1 + 0.9 * Math.pow(c.n / max, 0.6) : 0;
                  return (
                    <div
                      key={h}
                      className={`h-4 rounded-[3px] border border-input/30 ${c && onCellClick ? "cursor-pointer hover:ring-1 hover:ring-primary/70" : ""}`}
                      style={c ? { backgroundColor: `hsl(243 70% 56% / ${a.toFixed(2)})` } : undefined}
                      onClick={c && onCellClick ? () => onCellClick(c) : undefined}
                      title={
                        c
                          ? t("journal.cellTip", {
                              day: d,
                              hour: String(h).padStart(2, "0"),
                              requests: fnum(c.n, locale),
                              tokens: fmtKtok(c.tok, millionUnit),
                              people: c.ppl,
                              click: onCellClick ? ` · ${t("journal.cellTipEvaluate")}` : "",
                            })
                          : t("journal.cellTipEmpty", { day: d, hour: String(h).padStart(2, "0") })
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          {t("journal.legendLess")}
          {[0.1, 0.3, 0.55, 0.8, 1].map((a) => (
            <span key={a} className="inline-block h-3 w-3 rounded-[2px]" style={{ backgroundColor: `hsl(243 70% 56% / ${a})` }} />
          ))}
          {t("journal.legendMore")}
        </span>
        <span>{t("journal.timezoneNote")}</span>
      </div>
    </div>
  );
}
