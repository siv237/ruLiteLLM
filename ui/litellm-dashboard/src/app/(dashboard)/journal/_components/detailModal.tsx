"use client";

// fork: модалка строки «последней активности» — полный текст первой реплики (ленивая подгрузка)

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/components/networking";
import { cleanTxt, type RecentT } from "./shared";

interface Props {
  accessToken: string;
  item: RecentT & { n: number };
  hue: number;
  onClose: () => void;
  onOpenUser: (u: string) => void;
}

export default function DetailModal({ accessToken, item, hue, onClose, onOpenUser }: Props) {
  const { t } = useTranslation();
  const [full, setFull] = useState<string | null>(null);
  const [meta, setMeta] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!item.sid) {
      setFull(cleanTxt(item.txt, true));
      return;
    }
    let dead = false;
    (async () => {
      try {
        const r = await apiClient.get<{ txt: string; chars: number; truncated: boolean }>(
          `/dashboard/journal/message?sid=${encodeURIComponent(item.sid)}`,
          { accessToken },
        );
        if (dead) return;
        setFull(cleanTxt(r.txt || "", true) || cleanTxt(item.txt, true));
        setMeta(t("journal.msgMeta", { chars: r.chars, truncated: r.truncated ? t("journal.msgTruncated") : "" }));
      } catch (e) {
        if (dead) return;
        setError(String(e instanceof Error ? e.message : e));
        setFull(cleanTxt(item.txt, true));
      }
    })();
    return () => {
      dead = true;
    };
  }, [accessToken, item, t]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-input bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${hue} 65% 55%)` }} />
            <span className="truncate text-sm font-semibold">{item.display}</span>
            {item.n > 1 && (
              <span className="shrink-0 rounded-full border border-input px-1.5 text-[10px] tabular-nums text-muted-foreground">
                ×{item.n} {t("journal.repeats")}
              </span>
            )}
          </div>
          <button className="shrink-0 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="mb-2 text-[11px] text-muted-foreground">
          {t("journal.msgSessionLine", { time: item.t, turns: item.turns })}
          {item.n > 1 && ` · ${t("journal.repeatsInPeriod", { count: item.n })}`}
          {meta && ` · ${meta}`}
        </div>
        {error && <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-600">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-input/50 bg-background p-3 text-xs leading-relaxed">
          {full === null ? (
            <span className="text-muted-foreground">{t("journal.loadingFullText")}</span>
          ) : (
            <pre className="font-sans whitespace-pre-wrap break-words">{full}</pre>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button className="rounded border border-input px-3 py-1.5 text-xs hover:bg-muted/50" onClick={onClose}>
            {t("journal.close")}
          </button>
          <button
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => onOpenUser(item.u)}
          >
            {t("journal.openParticipant")}
          </button>
        </div>
      </div>
    </div>
  );
}
