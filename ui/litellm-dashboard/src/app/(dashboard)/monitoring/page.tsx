"use client";

import Monitoring from "./_components";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";

export default function MonitoringPage() {
  const { accessToken } = useAuthorized();
  return <Monitoring accessToken={accessToken} />;
}
