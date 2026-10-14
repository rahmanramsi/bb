import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

export function AdminSettingsGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return auth?.authMode === "multi" && auth.user?.role !== "admin" ? (
    <Navigate to="/settings/appearance" replace />
  ) : (
    children
  );
}
