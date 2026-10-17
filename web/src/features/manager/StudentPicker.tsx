import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { BoardStudentRow, ExamBoardResponse } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { EmptyState } from '../../ui/states.js';
import { hasPhoto } from '../common/labels.js';
import { keys } from '../common/hooks.js';
import { Chip } from '../common/ui.js';

/** The most students listed at once. */
export const MAX_SHOWN = 20;

export const uploadedCount = (student: BoardStudentRow) =>
  student.questions.filter((q) => hasPhoto(q.status)).length;

const label = (student: BoardStudentRow) =>
  student.rollNo ? `${student.rollNo} · ${student.name}` : student.name;

/** Students matching what was typed: roll number, name or email, in any case. */
export function matchStudents(students: readonly BoardStudentRow[], search: string) {
  const text = search.trim().toLowerCase();
  if (text === '') return [...students];
  return students.filter(
    (s) =>
      (s.rollNo ?? '').toLowerCase().includes(text) ||
      s.name.toLowerCase().includes(text) ||
      s.email.toLowerCase().includes(text),
  );
}

/** Marks a student absent or present, then refreshes the board. */
export function useSetAbsent(examId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, absent }: { email: string; absent: boolean }) =>
      api.setAbsent(examId, email, absent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.board(examId) }),
  });
}

/** Find a student by roll number, name or email, and mark them absent or present. */
export function StudentPicker({
  board,
  onPick,
}: {
  board: ExamBoardResponse;
  onPick: (email: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState<string | undefined>();
  const setAbsent = useSetAbsent(board.examId);

  const matches = useMemo(() => matchStudents(board.students, search), [board.students, search]);
  const shown = matches.slice(0, MAX_SHOWN);

  if (board.students.length === 0) {
    return (
      <EmptyState title="No students in this exam yet">
        Add the batch’s students first (Add students on the menu).
      </EmptyState>
    );
  }

  return (
    <div className="picker">
      <div className="field">
        <label htmlFor="student-search">Find a student</label>
        <p className="hint">Type a roll number, a name or an email.</p>
        <input
          id="student-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No student found">
          Check the spelling, or try the roll number.
        </EmptyState>
      ) : (
        <ul className="cards" aria-label="Students">
          {shown.map((student) => (
            <li key={student.email} className="card-item student">
              <button
                type="button"
                className="student-pick"
                aria-label={`Choose ${label(student)}`}
                onClick={() => onPick(student.email)}
              >
                <span className="row-title">{label(student)}</span>
                <span className="muted break">{student.email}</span>
                {student.absent ? (
                  <Chip tone="bad">Absent</Chip>
                ) : (
                  <Chip>
                    {uploadedCount(student)} of {student.questions.length} uploaded
                  </Chip>
                )}
              </button>

              {confirming === student.email ? (
                <div
                  className="confirm"
                  role="group"
                  aria-label={`Confirm ${student.name} is absent`}
                >
                  <p>
                    Mark <strong>{student.name}</strong> absent? Their marks will be 0 for this
                    exam.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="button button-danger"
                      disabled={setAbsent.isPending}
                      onClick={() =>
                        setAbsent.mutate(
                          { email: student.email, absent: true },
                          { onSettled: () => setConfirming(undefined) },
                        )
                      }
                    >
                      Yes, mark absent
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setConfirming(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : student.absent ? (
                <button
                  type="button"
                  className="button"
                  aria-label={`Mark ${student.name} present`}
                  disabled={setAbsent.isPending}
                  onClick={() => setAbsent.mutate({ email: student.email, absent: false })}
                >
                  Mark present
                </button>
              ) : (
                <button
                  type="button"
                  className="button"
                  aria-label={`Mark ${student.name} absent`}
                  onClick={() => setConfirming(student.email)}
                >
                  Mark absent
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {matches.length > MAX_SHOWN ? (
        <p className="muted">
          Showing {MAX_SHOWN} of {matches.length}. Keep typing to narrow the list.
        </p>
      ) : null}
    </div>
  );
}
