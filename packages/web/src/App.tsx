import { Navigate, Route, Routes } from "react-router-dom";
import { AgentWorkspacePage } from "./pages/AgentWorkspacePage";
import { ConfigurePage } from "./pages/ConfigurePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { WorkspaceWikiPage } from "./pages/WorkspaceWikiPage";

/**
 * Routes (plan §2) — id-only workspace URLs; zero legacy dual-tree.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workspaces" replace />} />
      <Route path="/workspaces" element={<WorkspacesPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/w/:id" element={<AgentWorkspacePage />} />
      <Route path="/w/:id/wiki/*" element={<WorkspaceWikiPage />} />
      <Route path="/w/:id/wiki" element={<WorkspaceWikiPage />} />
      <Route path="/w/:id/configure" element={<ConfigurePage />} />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
