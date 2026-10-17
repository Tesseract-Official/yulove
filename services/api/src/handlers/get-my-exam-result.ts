import {
  latestAppeal,
  mapLimit,
  MESSAGES,
  studentQuestionView,
  type AppealItem,
  type MyExamResultResponse,
} from '@yulove/shared';
import {
  answersDb,
  appealsDb,
  examStudentsDb,
  questionsDb,
  requireUser,
  totalFor,
} from '@yulove/shared/server';
import { loadPublishedExam } from '../lib/student.js';
import { apiHandler, pathParam, type ApiEvent, type ApiResult } from '../lib/http.js';

/**
 * GET /me/exams/{id} (student): the student's own result for a published exam of their batch:
 * marks per question, the failed tests they may see, and the status of their appeals. See
 * studentQuestionView for exactly what is, and is not, shown. The student is always the caller.
 */
export async function handle(event: ApiEvent): Promise<ApiResult> {
  const { user } = await requireUser(event, ['STUDENT']);
  const exam = await loadPublishedExam(user, pathParam(event, 'id'));

  const [answers, row, appeals] = await Promise.all([
    answersDb.listAnswersForStudent(exam.examId, user.email),
    examStudentsDb.getExamStudent(exam.examId, user.email),
    appealsDb.listAppealsByExam(exam.examId),
  ]);
  const absent = row?.absent === true;
  const answerOf = new Map(answers.map((a) => [a.questionNumber, a]));
  const mine = appeals.filter((a) => a.studentEmail === user.email);

  // The required complexity is only needed to explain a question the rule zeroed.
  const complexity = new Map<number, string>();
  await mapLimit(
    exam.questions.filter((q) => {
      const a = answerOf.get(q.number);
      return a?.status === 'GRADED' && a.meetsComplexity === false;
    }),
    5,
    async (ref) => {
      const question = await questionsDb.getQuestion(ref.questionId, ref.version);
      if (question) complexity.set(ref.number, question.targetComplexity);
    },
  );

  const questions = exam.questions.map((ref) => {
    const forQuestion: AppealItem[] = mine.filter((a) => a.questionNumber === ref.number);
    const latest = latestAppeal(forQuestion);
    return studentQuestionView({
      number: ref.number,
      marks: ref.marks,
      answer: answerOf.get(ref.number),
      absent,
      ...(complexity.has(ref.number)
        ? { targetComplexity: complexity.get(ref.number) as string }
        : {}),
      ...(latest ? { appeal: latest } : {}),
    });
  });

  const total = totalFor(exam, answers, absent);
  const body: MyExamResultResponse = {
    examId: exam.examId,
    title: exam.title,
    date: exam.date,
    absent,
    ...(absent ? { message: MESSAGES.absent } : {}),
    totalScore: total.totalScore,
    maxScore: total.maxScore,
    questions,
  };
  return { status: 200, body };
}

export const handler = apiHandler(handle);
