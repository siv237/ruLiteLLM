"use client";

import { useTranslation } from "react-i18next";
import { useState } from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { useHealthReadinessDetails } from "@/app/(dashboard)/hooks/healthReadiness/useHealthReadinessDetails";
import { getProxyBaseUrl } from "@/components/networking";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarHeader } from "@/components/shared/Sidebar";
import { uiHref } from "@/utils/uiHref";
import { cn } from "@/lib/cva.config";
import { productNames } from "@/i18n/untranslated/productNames";
import { resolveLogoSrc } from "@/lib/assetPaths";

const LOGO_CLASS_NAME = "h-7 w-7 shrink-0";

function bundledLogoSrc(baseUrl: string, { dark, monogram }: { dark: boolean; monogram: boolean }): string {
  const query = [dark && "theme=dark", monogram && "variant=monogram"].filter(Boolean).join("&");
  return `${baseUrl}/get_image${query ? `?${query}` : ""}`;
}

export function SidebarBrand({
  accessToken,
  homeHref = uiHref(""),
  homeLabel = "LiteLLM home",
  collapsed = false,
  onToggleCollapsed,
  onHomeClick,
}: {
  accessToken: string | null;
  homeHref?: string;
  homeLabel?: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onHomeClick?: () => void;
}) {
  const { t } = useTranslation();
  const { logoUrl, logoUrlDark } = useTheme();
  const [erroredDarkLogo, setErroredDarkLogo] = useState<string | null>(null);
  const { data: healthData } = useHealthReadinessDetails(accessToken);
  const version = healthData?.litellm_version;
  const baseUrl = getProxyBaseUrl();
  const markSrc = resolveLogoSrc("/ui/assets/logos/rulitellm_mark.png");
  const logoSrc = logoUrl || markSrc || bundledLogoSrc(baseUrl, { dark: false, monogram: collapsed });
  const reachableDarkLogo = logoUrlDark === erroredDarkLogo ? null : logoUrlDark;
  const darkLogoSrc = reachableDarkLogo || logoUrl || markSrc || bundledLogoSrc(baseUrl, { dark: true, monogram: collapsed });
  return (
    <SidebarHeader className="h-14 border-b border-border group-data-[collapsed=true]/sidebar:h-auto group-data-[collapsed=true]/sidebar:py-2">
      <div className="flex items-center justify-between gap-2 group-data-[collapsed=true]/sidebar:flex-col group-data-[collapsed=true]/sidebar:gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={homeHref} onClick={onHomeClick} className="flex min-w-0 items-center" aria-label={homeLabel}>
            <img src={logoSrc} alt={productNames.ruLiteLLM} className={cn(LOGO_CLASS_NAME, "dark:hidden")} />
            <img
              src={darkLogoSrc}
              alt=""
              aria-hidden
              onError={() => setErroredDarkLogo(logoUrlDark)}
              className={cn(LOGO_CLASS_NAME, "hidden dark:block")}
            />
            <span className="truncate text-base font-semibold leading-none group-data-[collapsed=true]/sidebar:hidden">
              {productNames.ruLiteLLM}
            </span>
          </Link>
          {version && (
            <Badge
              variant="outline"
              render={<a href="https://docs.litellm.ai/release_notes" target="_blank" rel="noopener noreferrer" />}
              className="px-1.5 py-0 font-mono text-[10px] font-medium text-muted-foreground group-data-[collapsed=true]/sidebar:hidden"
            >
              v{version}
            </Badge>
          )}
        </div>
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("shell.navbar.expandSidebar") : t("shell.navbar.collapseSidebar")}
            className="flex-none text-muted-foreground group-data-[collapsed=true]/sidebar:size-9"
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        )}
      </div>
    </SidebarHeader>
  );
}
