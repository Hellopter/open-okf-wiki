import { Navigate, Route, Routes } from "react-router-dom";
import { ConfigurePage } from "./pages/ConfigurePage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunReviewPage } from "./pages/RunReviewPage";
import { RunSessionPage } from "./pages/RunSessionPage";
import { RunWorkspacePage } from "./pages/RunWorkspacePage";
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
      <Route path="/w/:id" element={<Navigate to="runs" replace />} />
      <Route path="/w/:id/runs" element={<RunWorkspacePage />} />
      <Route path="/w/:id/runs/:runId" element={<RunDetailPage />} />
      <Route path="/w/:id/runs/:runId/review" element={<RunReviewPage />} />
      <Route path="/w/:id/sessions/:sessionId" element={<RunSessionPage />} />
      <Route path="/w/:id/wiki/*" element={<WorkspaceWikiPage />} />
      <Route path="/w/:id/wiki" element={<WorkspaceWikiPage />} />
      <Route path="/w/:id/configure" element={<ConfigurePage />} />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
