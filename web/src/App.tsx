import { Navigate, Route, Routes } from "react-router-dom";
import { HeaderShell } from "@/components/HeaderShell";
import { PageStub } from "@/components/PageStub";
import { CommandPaletteHost } from "@/components/CommandPalette";
import { GlobalPermissionDialog } from "@/components/GlobalPermissionDialog";
import Tasks from "@/pages/Tasks";
import TaskDetail from "@/pages/TaskDetail";
import Sessions from "@/pages/Sessions";
import Apps from "@/pages/Apps";
import Tunnels from "@/pages/Tunnels";
import Usage from "@/pages/Usage";
import Settings from "@/pages/Settings";

/**
 * Top-level route map. Mounts the global Cmd+K palette host and the
 * cross-session permission dialog so they're available everywhere.
 */
export default function App() {
  return (
    <div className="min-h-full flex flex-col bg-bg text-fg">
      <HeaderShell />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/tasks" replace />} />
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
      <GlobalPermissionDialog />
    </div>
  );
}
