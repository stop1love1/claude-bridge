import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { HeaderShell } from "@/components/HeaderShell";
import { PageStub } from "@/components/PageStub";
import { CommandPaletteHost } from "@/components/CommandPalette";
import { GlobalPermissionDialog } from "@/components/GlobalPermissionDialog";
import { LoginApprovalDialog } from "@/components/LoginApprovalDialog";
import Tasks from "@/pages/Tasks";
import TaskDetail from "@/pages/TaskDetail";
import Sessions from "@/pages/Sessions";
import Apps from "@/pages/Apps";
import Tunnels from "@/pages/Tunnels";
import Usage from "@/pages/Usage";
import Settings from "@/pages/Settings";

// Marketing pages are lazy-loaded so the dashboard bundle stays slim
// for the operator's primary path (/tasks). The landing + docs JSX is
// content-heavy (~1300 LOC of tables and prose) but rarely visited
// once an operator has bookmarked the dashboard.
const Landing = lazy(() => import("@/pages/Landing"));
const Docs = lazy(() => import("@/pages/Docs"));

/**
 * Top-level route map. Mounts the global Cmd+K palette host and the
 * cross-session permission dialog so they're available everywhere.
 *
 * The marketing surfaces (`/`, `/docs`) ship their own `LandingHeader`
 * + `LandingFooter` chrome, so we suppress the dashboard `HeaderShell`
 * (and the `<main>` wrapper that pads dashboard pages) while they're
 * mounted. `/dashboard` is a courtesy redirect for users who muscle-
 * memoried it from the legacy Next.js app.
 */
const PUBLIC_PATHS = new Set<string>(["/", "/docs"]);

export default function App() {
  const { pathname } = useLocation();
  const isPublic = PUBLIC_PATHS.has(pathname);

  if (isPublic) {
    return (
      <div className="min-h-full flex flex-col bg-background text-foreground">
        <Suspense fallback={<div className="min-h-screen bg-background" />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/docs" element={<Docs />} />
          </Routes>
        </Suspense>
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col bg-background text-foreground">
      <HeaderShell />
      <main className="flex-1">
        <Routes>
          <Route path="/dashboard" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/apps" element={<Apps />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/tunnels" element={<Tunnels />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<PageStub title="Not Found" />} />
        </Routes>
      </main>
      <CommandPaletteHost />
      <LoginApprovalDialog />
      <GlobalPermissionDialog />
    </div>
  );
}
