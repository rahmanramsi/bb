import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useActsAsMember } from "@/hooks/useAuth";

export function AdminSettingsGate({ children }: { children: ReactNode }) {
  return useActsAsMember() ? (
    <Navigate to="/settings/appearance" replace />
  ) : (
    children
  );
}
