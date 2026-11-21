"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import useCan from "@/app/(dashboard)/hooks/useCan";
import DeletedKeysPage from "@/components/DeletedKeysPage/DeletedKeysPage";
import DeletedTeamsPage from "@/components/DeletedTeamsPage/DeletedTeamsPage";
import Journal from "@/app/(dashboard)/journal/_components";
import RequestLogsPanel from "@/components/logs/request/RequestLogsPanel";
import { Page, PageTabs, PageTabsList, PageTabsTrigger, PageTabsContent } from "@/components/shared/Page";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { isAdminRole } from "@/utils/roles";

type LogsTab = "request logs" | "audit logs" | "deleted keys" | "deleted teams";

export default function LogsPage() {
  const { t } = useTranslation();
  const { accessToken, userRole, userId, token } = useAuthorized();
  const [activeTab, setActiveTab] = useState<LogsTab>("request logs");
  // fork: enterprise-вкладка «Audit Logs» заменена нашим журналом активности (admin-only)
  const showJournal = isAdminRole(userRole || "");
  const canViewDeletedTeams = useCan("viewDeletedTeams");

  const credentialsPending = !accessToken || !token;
  const identityPending = !userRole || !userId;

  if (credentialsPending || identityPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("logs.page.loading")}
        className="flex h-64 items-center justify-center"
      >
        <UiLoadingSpinner className="size-8 text-primary" />
      </div>
    );
  }

  return (
    <Page className="h-full">
      <PageTabs value={activeTab} onValueChange={(value: LogsTab) => setActiveTab(value)}>
        <PageTabsList>
          <PageTabsTrigger value="request logs">{t("logs.page.tabs.requestLogs")}</PageTabsTrigger>
          {showJournal && <PageTabsTrigger value="audit logs">{t("journal.activityTitle")}</PageTabsTrigger>}
          <PageTabsTrigger value="deleted keys">{t("logs.page.tabs.deletedKeys")}</PageTabsTrigger>
          {canViewDeletedTeams && (
            <PageTabsTrigger value="deleted teams">{t("logs.page.tabs.deletedTeams")}</PageTabsTrigger>
          )}
        </PageTabsList>

        <PageTabsContent value="request logs" keepMounted>
          <RequestLogsPanel
            accessToken={accessToken}
            token={token}
            userRole={userRole}
            userID={userId}
            isActive={activeTab === "request logs"}
          />
        </PageTabsContent>
        {showJournal && (
          <PageTabsContent value="audit logs" keepMounted>
            <Journal accessToken={accessToken} />
          </PageTabsContent>
        )}
        <PageTabsContent value="deleted keys" keepMounted>
          <DeletedKeysPage />
        </PageTabsContent>
        {canViewDeletedTeams && (
          <PageTabsContent value="deleted teams" keepMounted>
            <DeletedTeamsPage />
          </PageTabsContent>
        )}
      </PageTabs>
    </Page>
  );
}
