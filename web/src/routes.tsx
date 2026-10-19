import { Navigate, Route, Routes } from 'react-router-dom';
import { CallbackPage, LandingRoute } from './auth/pages.js';
import { AdminHome } from './features/admin/AdminHome.js';
import { BatchesPage } from './features/admin/BatchesPage.js';
import { StaffPage } from './features/admin/StaffPage.js';
import { AnswerPage } from './features/manager/AnswerPage.js';
import { BoardPage } from './features/manager/BoardPage.js';
import { ImportPage } from './features/manager/ImportPage.js';
import { ManagerHome } from './features/manager/ManagerHome.js';
import { StudentsPage } from './features/manager/StudentsPage.js';
import { UploadPage } from './features/manager/UploadPage.js';
import { ExamPage } from './features/teacher/ExamPage.js';
import { ExamsPage } from './features/teacher/ExamsPage.js';
import { QuestionFormPage } from './features/teacher/QuestionFormPage.js';
import { QuestionsPage } from './features/teacher/QuestionsPage.js';
import { QuestionTestsPage } from './features/teacher/QuestionTestsPage.js';
import { ResultsPage } from './features/teacher/ResultsPage.js';
import { TeacherHome } from './features/teacher/TeacherHome.js';
import { AppealDetailPage } from './features/appeals/AppealDetailPage.js';
import { AppealsPage } from './features/appeals/AppealsPage.js';
import { LegacyAppeals } from './features/appeals/LegacyAppeals.js';
import { StudentExamPage } from './features/student/StudentExamPage.js';
import { StudentExamsPage } from './features/student/StudentExamsPage.js';
import { RequireSection } from './session/guards.js';
import { SessionGate } from './session/SessionGate.js';
import { Shell } from './ui/Shell.js';

/**
 * `/` and `/auth/callback` are public. Everything else sits behind SessionGate, and each section
 * additionally behind a role check.
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
          <Route path="students" element={<StudentsPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="board" element={<BoardPage />} />
          <Route path="appeals" element={<LegacyAppeals />} />
          <Route path="appeals/:examId/:appealId" element={<LegacyAppeals />} />
          <Route path="answer/:examId/:email/:q" element={<AnswerPage />} />
          <Route path="*" element={<Navigate to="/manager" replace />} />
        </Route>
        <Route path="teacher" element={<RequireSection section="TEACHER" />}>
          <Route index element={<TeacherHome />} />
          <Route path="questions" element={<QuestionsPage />} />
          <Route path="questions/new" element={<QuestionFormPage />} />
          <Route path="questions/:id" element={<QuestionFormPage />} />
          <Route path="questions/:id/tests" element={<QuestionTestsPage />} />
          <Route path="exams" element={<ExamsPage />} />
          <Route path="exams/new" element={<ExamPage />} />
          <Route path="exams/:id" element={<ExamPage />} />
          <Route path="results" element={<ResultsPage />} />
          <Route path="appeals" element={<AppealsPage />} />
          <Route path="appeals/:examId/:appealId" element={<AppealDetailPage />} />
          <Route path="answer/:examId/:email/:q" element={<AnswerPage section="teacher" />} />
          <Route path="*" element={<Navigate to="/teacher" replace />} />
        </Route>
        <Route path="student" element={<RequireSection section="STUDENT" />}>
          <Route index element={<StudentExamsPage />} />
          <Route path="exams/:id" element={<StudentExamPage />} />
          <Route path="*" element={<Navigate to="/student" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
