"use client";

import RequestGantt from "./_components";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";

export default function RequestGanttPage() {
  const { accessToken } = useAuthorized();
  return <RequestGantt accessToken={accessToken} />;
}
