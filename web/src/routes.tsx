import { Navigate, Route, Routes } from 'react-router-dom';
import { CallbackPage, LandingRoute } from './auth/pages.js';
import { AdminHome } from './features/admin/AdminHome.js';
import { BatchesPage } from './features/admin/BatchesPage.js';
import { StaffPage } from './features/admin/StaffPage.js';
import { AnswerPage } from './features/manager/AnswerPage.js';
import { BoardPage } from './features/manager/BoardPage.js';
import { ImportPage } from './features/manager/ImportPage.js';
import { ManagerHome } from './features/manager/ManagerHome.js';
import { UploadPage } from './features/manager/UploadPage.js';
import { StudentHome, TeacherHome } from './sections/homes.js';
import { RequireSection } from './session/guards.js';
import { SessionGate } from './session/SessionGate.js';
import { Shell } from './ui/Shell.js';

/**
 * `/` and `/auth/callback` are public. Everything else sits behind SessionGate, and each section
 * additionally behind a role check. The teacher and student sections are still placeholders.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route path="/auth/callback" element={<CallbackPage />} />
      <Route
        element={
          <SessionGate>
            <Shell />
          </SessionGate>
        }
      >
        <Route path="admin" element={<RequireSection section="SUPER_ADMIN" />}>
          <Route index element={<AdminHome />} />
          <Route path="staff" element={<StaffPage />} />
          <Route path="batches" element={<BatchesPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
        <Route path="manager" element={<RequireSection section="BATCH_MANAGER" />}>
          <Route index element={<ManagerHome />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="board" element={<BoardPage />} />
          <Route path="answer/:examId/:email/:q" element={<AnswerPage />} />
          <Route path="*" element={<Navigate to="/manager" replace />} />
        </Route>
        <Route path="teacher" element={<RequireSection section="TEACHER" />}>
          <Route index element={<TeacherHome />} />
          <Route path="*" element={<Navigate to="/teacher" replace />} />
        </Route>
        <Route path="student" element={<RequireSection section="STUDENT" />}>
          <Route index element={<StudentHome />} />
          <Route path="*" element={<Navigate to="/student" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
