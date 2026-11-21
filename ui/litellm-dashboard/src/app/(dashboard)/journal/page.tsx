"use client";

import Journal from "./_components";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";

export default function JournalPage() {
  const { accessToken } = useAuthorized();
  return <Journal accessToken={accessToken} />;
}
