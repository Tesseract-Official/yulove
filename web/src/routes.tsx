import { Navigate, Route, Routes } from 'react-router-dom';
import { CallbackPage, LandingRoute } from './auth/pages.js';
import { AdminHome, ManagerHome, StudentHome, TeacherHome } from './sections/homes.js';
import { RequireSection } from './session/guards.js';
import { SessionGate } from './session/SessionGate.js';
import { Shell } from './ui/Shell.js';

/**
 * `/` and `/auth/callback` are public. Everything else sits behind SessionGate, and each section
 * additionally behind a role check. Sections are placeholders for now.
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
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
        <Route path="manager" element={<RequireSection section="BATCH_MANAGER" />}>
          <Route index element={<ManagerHome />} />
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
