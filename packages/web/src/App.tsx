import { Navigate, Route, Routes } from "react-router-dom";
import { ConfigurePage } from "./pages/ConfigurePage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunReviewPage } from "./pages/RunReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspaceAgentPage } from "./pages/WorkspaceAgentPage";
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
      <Route path="/w/:id" element={<WorkspaceAgentPage />} />
      <Route path="/w/:id/runs/:runId" element={<RunDetailPage />} />
      <Route path="/w/:id/runs/:runId/review" element={<RunReviewPage />} />
      <Route path="/w/:id/wiki/*" element={<WorkspaceWikiPage />} />
      <Route path="/w/:id/wiki" element={<WorkspaceWikiPage />} />
      <Route path="/w/:id/configure" element={<ConfigurePage />} />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
