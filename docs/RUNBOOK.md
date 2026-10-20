# Runbook

How to run the Paper DSA Exam Judge day to day. It is written for the founders, in plain language. For how the system works inside, read [DESIGN.md](DESIGN.md).

Two rules before anything else:

- **Flags go straight after the command.** Write `pnpm cleanup:dev-data --dry-run`, not `pnpm cleanup:dev-data -- --dry-run`. (The scripts tolerate an extra `--`, but don't rely on it.)
- **Nothing here deploys by itself.** Every step that changes AWS is a command you type on purpose.

## Contents

1. [The basics](#1-the-basics)
2. [Every working day: logging in and deploying](#2-every-working-day-logging-in-and-deploying)
3. [People: teachers, batch managers, founders](#3-people-teachers-batch-managers-founders)
4. [Start of a semester](#4-start-of-a-semester)
5. [A normal week: teachers](#5-a-normal-week-teachers)
6. [A normal week: batch managers](#6-a-normal-week-batch-managers)
   - [Taking answer photos](#taking-answer-photos)
7. [What students see, and appeals](#7-what-students-see-and-appeals)
8. [Overriding a score, and the audit log](#8-overriding-a-score-and-the-audit-log)
9. [Answers that could not be graded](#9-answers-that-could-not-be-graded)
10. [Gemini](#10-gemini)
11. [Alarms](#11-alarms)
12. [Costs](#12-costs)
13. [Rolling back](#13-rolling-back)
14. [Practice-exam checklist](#14-practice-exam-checklist)

## 1. The basics

**What runs where**

- The **website** runs on Vercel. Every push to the `main` branch on GitHub makes Vercel build and publish it again by itself.
- Everything else runs in **AWS**, region `ap-south-1` (Mumbai), as seven **stacks** (a stack is a bundle of AWS things that is deployed together):

| Stack                | What is in it                                                                        |
| -------------------- | ------------------------------------------------------------------------------------ |
| `DsaJudgeData`       | The database tables, the photo and file bucket, the secret that holds the Gemini key |
| `DsaJudgeAuth`       | Sign-in (Cognito and Google)                                                         |
| `DsaJudgeQueues`     | The three waiting lines (queues) that grading moves through                          |
| `DsaJudgePipeline`   | The programs that read the photo with Gemini, record results and generate tests      |
| `DsaJudgeApi`        | The programs behind every button on the website                                      |
| `DsaJudgeWorker`     | The machine that runs students' code (switched off when idle)                        |
| `DsaJudgeBudget`     | The monthly spending warning                                                         |
| `DsaJudgeMonitoring` | The alarms                                                                           |

**Words used here**

- **Deploy**: send the code in this folder to AWS so it goes live.
- **Batch**: a class group of students. Each exam belongs to one batch.
- **Exam**: the set of questions a batch writes in one week.
- **Appeal**: a student asking for one question to be looked at again.
- **Override**: a teacher or a founder setting a question's score by hand.
- **Practice data / dev data**: sample data that is marked `dev` so it can be removed later in one go.

**Your AWS login name.** The commands below use the profile name `dsa-judge`. Use whatever name you gave your AWS login profile.

## 2. Every working day: logging in and deploying

### Log in to AWS

Your AWS login expires every few hours. When a command says the token has expired or credentials are missing:

```bash
aws sso login --profile dsa-judge
```

A browser window opens; approve it. Then put `AWS_PROFILE=dsa-judge` in front of every command that talks to AWS (the examples below do).

### Get the code ready

Once per terminal window, in the project folder:

```bash
nvm use
pnpm install
```

`nvm use` switches to Node 22 (the version in the file `.nvmrc`). `pnpm install` is only needed after you pulled changes.

### Deploy

Always run the checks first. They take a couple of minutes and catch most mistakes:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Look at what would change, without changing anything:

```bash
AWS_PROFILE=dsa-judge pnpm --filter @yulove/infra cdk diff
```

Then deploy. The simple way is everything that changed (AWS skips what did not):

```bash
AWS_PROFILE=dsa-judge pnpm --filter @yulove/infra cdk deploy --all
```

Or only one stack, if you know which one you changed:

```bash
AWS_PROFILE=dsa-judge pnpm --filter @yulove/infra cdk deploy DsaJudgeApi
```

| You changed                                                                              | Deploy                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| API code (`services/api`)                                                                | `DsaJudgeApi`                                                      |
| Gemini, grading or test-generation code, or the prompts (`services/pipeline`, `prompts`) | `DsaJudgePipeline`                                                 |
| Code the worker runs (`worker`)                                                          | `DsaJudgeWorker` (Docker Desktop must be running on your computer) |
| `infra/cdk.json` (models, web address, emails)                                           | `--all`                                                            |
| Shared code (`packages/shared`)                                                          | `--all`                                                            |

**The website** needs no command: push to `main` and Vercel publishes it. Watch the deployment on the Vercel dashboard. If you add a new web address, add it to `webOrigin` in `infra/cdk.json` (comma-separated, keep `http://localhost:5173`) and redeploy `--all`, because sign-in and uploads only accept the addresses on that list. The Vercel settings (three environment variables) are in `web/README.md`; `AWS_PROFILE=dsa-judge pnpm web:vercel-env` prints their values.

**After a deploy**, open the website, sign in, and open the screen that uses what you changed. The alarms (section 11) will email you if something is badly wrong.

### The first emails

The first time `DsaJudgeMonitoring` is deployed, AWS sends a "Confirm subscription" email to the address in `budgetEmail`. Click the link in it, or the alarms will never reach you. The budget warning (section 12) needs no confirmation.

## 3. People: teachers, batch managers, founders

Founders are the **super admins**. They are listed in `superAdminEmails` in `infra/cdk.json`. To add a founder: add the address there, deploy `--all`, then run:

```bash
AWS_PROFILE=dsa-judge pnpm seed:super-admins
```

**Teachers and batch managers** are created by a founder on the website:

1. Sign in, open **Teachers and batch managers**.
2. Add the person with their email, name and role (teacher or batch manager), and tick the batches they work with. **Teachers and batch managers can use any Google account**: a Gmail address, a Google Workspace address from another organisation, or the college one. Only students need a college email.
3. To change their batches later, edit them on the same screen.

They then press **Sign in with Google** and choose that same account. Someone who is not in the list, or who has been made inactive, cannot sign in at all, whatever their address. (Students are the exception to "any address": see section 4.)

**One-time Google setting.** The Google sign-in app (in the Google Cloud console, under _APIs & Services → OAuth consent screen_) must have its user type set to **External**. If it is **Internal** to one Workspace organisation, Google refuses Gmail and other-domain accounts before this app is even reached, and staff on those accounts see a Google error. Ask a developer to check it once.

A teacher or batch manager only sees the batches they are assigned to. A teacher only changes the questions and exams they made themselves.

**Taking someone's access away (making them inactive).** Open **Teachers and batch managers**. Each person has an **Active / Inactive** switch. Press it, type the reason (required, and kept in the audit log) and confirm. From then on every request they make is refused: they can still sign in with Google, but the app only shows "Your account isn't registered, or it has been made inactive" and they can do nothing. Inactive people are greyed out with an **Inactive** label. Nothing about them is deleted: their questions, exams, marks and answers stay. Press the switch again, with a reason, to make them active again.

Two protections: you cannot make **yourself** inactive, and the **last active founder** can never be made inactive (so someone can always sign in as a founder). Founders can also switch another founder off through the API, but there is no screen for founders yet.

A batch manager can do the same for **students of their own batches**: see section 4, step 5.

## 4. Start of a semester

1. **Create the batches.** A founder opens **Batches** and adds each one (a short id such as `2026-cse-a` and a name).
2. **Assign people to them.** Teachers and batch managers, as in section 3.
3. **Add the students.** The batch manager opens **Add students**, chooses the file and presses **Upload students**. The file is a CSV file with four columns and a header row: name, college email, roll number, batch. Header spelling is forgiving ("College email", "Roll no" and so on). Up to 2,000 rows. The result lists each row as **created**, **updated** (already there, details refreshed) or **rejected** with the reason (for example an email outside the college domain, a roll number used twice, or a batch the manager is not assigned to). Fix the rejected rows in the file and upload again; rows already created are simply updated.
4. **Students sign in with their college email.** Students must use an address on the college domain; the CSV upload rejects any other, and a student record on another domain cannot sign in. They open the website and press **Sign in with Google**. They only get in if they were added in step 3. New students can be added at any time; they appear in exams from their first visit.
5. **When a student leaves**, the batch manager opens **Students**, picks the batch, finds the student and presses their **Active / Inactive** switch, giving a reason. The student is greyed out with an **Inactive** label, can no longer use the app (they see "Your account isn't registered, or it has been made inactive"), and cannot be chosen on the upload screen; their marks and answers are kept. Press the switch again (with a reason) if they come back. A batch manager can only change students of batches they are assigned to. A CSV upload does not make an inactive student active again.
6. **Founders never go in the student CSV.** Their addresses are blocked there on purpose.

## 5. A normal week: teachers

Everything is under **Questions** and **Exams** on the teacher's home screen.

1. **Write the question.** Questions → new question: title, statement, what the input and output are, constraints, one to three examples, the time complexity you expect (for example `O(n log n)`), time and memory limits and how the answer is compared (exactly, in any order, or numbers within 0.000001). The page can suggest the function name to put in the statement.
2. **Generate tests.** Open the question's tests page and press **Generate tests**. Gemini writes a reference solution and ten tests (seven small, three large). The first time can take a few minutes: press **Refresh** until the status changes. If it says it failed, read the reason and press Generate again.
3. **Review the tests.** When the status is **Ready for review** you see the function signature and all ten tests with their expected answers. Read them like a student would. If the expected answers look wrong, press **Regenerate** instead of approving; a wrong reference solution would mark every student wrong.
4. **Approve.** Press **Approve**. Only approved questions can go into an exam.
5. **Make the exam.** Exams → new exam: choose the batch, the title and date, add approved questions in order and give each its marks.
6. **Make the PDF.** Open the exam and press **Generate PDF** (**Make the PDF again** if you changed the exam); then **Download PDF** to print or project it. Only the teacher who created the exam can make it; any teacher or batch manager of the batch can download it.

Good to know:

- Once any answer exists for an exam, its questions and marks are locked (the title and date can still change).
- If you edit a question that is already used in an exam with answers, the system makes a new version of it; the old exam keeps the old version. Changing only the title or the examples keeps the generated tests; changing anything else means generating and approving again.
- Students write one answer per page and only the function, not the input and output code. The PDF says so.

After the exam, **Results** shows every student's score per question and in total, by name. **Appeals** (section 7) are handled by any teacher of the batch.

## 6. A normal week: batch managers

1. **Before the exam**: nothing, apart from making sure the students are added (section 4) and the exam's PDF exists.
2. **After the exam**, open **Upload answers**. Everything from the camera to Send is on one screen:
   1. Choose the batch and the exam, then the student (search by roll number, name or email). The app remembers the last exam and student for next time.
   2. The top of the screen shows the student and the question, with **‹ ›** buttons for the previous or next question and student (students who are absent are skipped), and a row such as **Q1 ✓ Q2 ✓ Q3 •** showing which questions have a photo. Tap a question in the row to go to it.
   3. Press **Take a photo** (it opens the phone's camera) or **Choose from gallery**.
   4. Adjust the photo on the same screen: drag the corners and edges of the white box so it frames just the answer page (it starts on the page edges when the app can find them; **Whole photo** puts it back to the full picture). Pinch to zoom, or use **+**, **−** and **Fit**; drag the photo to move it; **↺ ↻** turn it a quarter; **Retake** starts again. Press **Next**.
   5. Look at the preview, which is exactly what will be sent, and press **Send**. The photo goes up in the background with a progress bar, and the camera opens for the next question straight away. After the last question you arrive at the next student who is not absent and still has questions without a photo.
   6. A photo that cannot be sent stays on the screen with the reason and a **Retry** chip (**Retry all** if there are several). It is never thrown away unless you press **Discard**. Unsent photos live only in this open page, so keep it open until the row shows ✓ for everything; if you close or reload the page while photos are unsent, the browser asks first. You can move to other pages in the app and the photos keep going up; a yellow or red bar tells you if any are still unsent.
   7. To replace a photo, tap that question in the row and take a new one. The old one is kept as an older version. **Choose another student** goes back to the list.
3. **Students who were absent**: mark them absent from the same student picker. An absent student scores zero everywhere and shows "Absent"; uploads for them are blocked until you unmark them.
4. **Check grading and publish**: this is the status board. It lists every student and every question with a status (not submitted, queued, being read, being graded, graded, or could not be graded). Press **Refresh** to update it; it does not refresh itself. A big batch takes a while, since photos are read a few at a time. From the board you can:
   - open an answer to see the photo, what Gemini read and the tests that failed;
   - **Grade again** (re-run) an answer, for example one that could not be graded;
   - download the exam PDF.
5. **Publish.** When the board looks right, press **Publish results**. If some answers are still being graded it warns you and shows how many; you may press **Publish anyway** and those answers will update later. Students see nothing before this moment. Publishing again does nothing.

Grading again after publishing is fine: the student's calculated score is replaced by the new one (a score a teacher or founder set by hand stays until they remove it; see section 8).

**Batch managers do not see appeals.** Appeals are handled by the batch's teachers. If a student tells you they have appealed, ask them to wait for their teacher; if the teacher asks for a better photo, upload it from **Upload answers** (tap that question in the row, take the new photo and press **Send and replace**).

### Taking answer photos

Gemini can only grade what it can read, and a poor photo is the most common reason for a wrong mark or an appeal. A few seconds per photo saves a lot of re-grading:

- **One page, flat, filling the frame.** Lay the page flat and hold the phone straight above it, so the lines of writing run straight across. Let the page fill the screen so the writing is big.
- **Good, even light.** Use daylight or a bright room. Keep your own and the phone's shadow off the page, and switch the flash off (it makes a glare patch).
- **Hold still and let it focus.** Tap the page on the camera screen to focus, then take the photo. Blurry words cannot be read, however good the crop.
- **Check the preview before Send.** Can you read every line, with nothing cut off at the edges or bottom? If not, press **Back to adjust** to fix the box, or **Retake**.
- **Crop to the answer, but keep all of it.** Cut away the table and other pages, and keep every line of the code, including anything written in the margin.
- **Sideways is fine.** Phone photos are turned upright by themselves; if one is not, use **↺ ↻**. Before you leave the page, check that every question shows ✓ and no photo has a red **Retry**.

## 7. What students see, and appeals

After publishing, a student opens **Your results**, picks the exam and sees for each question: marks out of the total, how many of the ten tests passed, and for failed small tests the input, the expected output and their output. Failed large tests show only "Large test 2: time limit exceeded" (or the verdict). Special lines appear for:

- "Did not meet the required time complexity" (the question scored zero for being too slow in principle);
- "Could not be graded — raise an appeal";
- "Still being graded", "No answer was submitted", "Absent";
- "Score adjusted by teacher" (a teacher set it by hand). When a founder changes a score the student sees only the new score and no label at all.

Under each answered question the student also sees **their own photo, exactly as it was sent for grading** (after cropping and turning), from the latest upload. Tapping it opens it full screen, where two fingers zoom and one finger drags (a laptop has **Zoom in** and **Zoom out** buttons). The photo is only shown after you publish, only to the student who wrote the answer, and the link behind it works for **5 minutes** and is made fresh each time: if a student leaves the page open for a long time it fetches a new link by itself, or they can press **Try again**. If you replace a photo (**Send and replace**), the student sees the new one once the answer is graded again. Note that a replaced photo is shown as soon as it is uploaded, a few seconds before it has been sent for grading again.

Students never see the code that was read, another student's photo, or who handled their appeal.

**An appeal** starts when a student presses **Raise an appeal** on one question. They must choose a reason ("Photo is unclear or cut off", "My code was read wrong", "Wrong marks for a correct answer" or "Other") and write a short message (up to 1,000 characters). Only one appeal can be open per question. Appeals made before reasons existed show no reason.

**Teachers** handle appeals, under **Appeals** on the Teacher menu. Any teacher assigned to the batch can open its appeals (choose batch and exam; open ones come first), not only the teacher who made the exam; founders see every exam. A teacher of another batch, or one who has been taken off the batch, cannot open them, and batch managers cannot see appeals at all. Anyone following an old link to the appeals pages in the Batch manager menu is sent to the teacher page (founders) or told it is not allowed (batch managers). Opening one shows, together on one page, the reason and message, the photo (with zoom), what Gemini read, the corrected code, the fixes and the test results, so you can decide without opening anything else. If the reason is "Photo is unclear or cut off" the page says: "Ask the batch manager to upload a better photo, then re-grade." Then choose:

- **Re-grade as is**: grade the stored photo again.
- **Upload a better photo and re-grade**: only founders can do this from the appeal, because only founders and batch managers can upload photos. A teacher who needs a better photo asks a batch manager to upload it from **Upload answers**, then presses **Refresh** here and either re-grades or closes the appeal.
- **Close with a note**: a note is required; the student sees it.

After a re-grade press **Refresh** on the appeal to watch the new result. The student sees the status ("Waiting for a reviewer", "Your answer was graded again", "Closed") and your note.

## 8. Overriding a score, and the audit log

Any **teacher of the exam's batch** can set a score by hand, and so can the **founders** for any exam. Batch managers and students cannot.

1. Open the answer (a teacher: from **Results** or an appeal; a founder: also from the status board).
2. Press **Override score**, type the new score (between 0 and the question's marks) and a reason. The reason is required.
3. To go back to the calculated score, open the same dialog and choose to remove the override (a reason is required for that too).

An override stays through re-runs until a teacher or founder removes it, so grading the answer again changes the calculated score but not the one set by hand. It cannot be set for a student marked absent: take away "absent" first. Students then see "Score adjusted by teacher" if a teacher did it (just those words, never who it was or why), and nothing extra if a founder did.

**Audit history** (a panel on the same answer page, for teachers of the batch and founders) lists every change to that score, newest first: who (email and whether they were a teacher), when, old and new score and the reason. Students never see it, and neither do batch managers. Teachers see only the changes made by teachers; changes made by a founder are not in what the server sends them. A founder sees all of them, and their own are marked **Super admin action: hidden from everyone else**.

**Founders' actions are invisible to everyone else.** Whatever a founder does (an override, a re-grade or closing an appeal, making or publishing an exam, switching someone off) takes effect normally, but teachers, batch managers and students are never told who did it: no email, no role, no "admin" label. They see the result (the new score, the appeal's new status and note, the exam) and, where a name would normally appear (who handled an appeal, who made an exam), nothing. Only founders can read the trace.

Separately, the system quietly records every request a founder makes that changes something, and every time a founder reads results or an answer: who, what, when and whether it worked (never the contents). Founders cannot switch this off, and nobody else can read it.

**If the audit history shows "Could not load the history".** The history route reads the exam to check the caller may review it, so its Lambda needs read access to the `Exams` table. If that grant is missing in `infra/src/routes.ts` the Lambda fails with `Missing environment variable EXAMS_TABLE` (look for that text in the `get-answer-audit` log group). The entries themselves are safe: they are written by the override route and read by key, so nothing is lost while the history cannot be read. The test `services/api/src/route-permissions.test.ts` runs every handler with only its route's tables to catch this before a deploy.

## 9. Answers that could not be graded

These show as **could not be graded** on the status board, with a reason. Students see "Could not be graded — raise an appeal".

| Reason               | What it means                                                                                                                                         | What to do                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unreadable           | Gemini could not read the page (blurry, dark, cut off)                                                                                                | Upload a clearer photo and re-grade. If the handwriting really cannot be read, a teacher or founder can override the score |
| Unsupported language | The code is not Python, C++, Java or Go                                                                                                               | It cannot be graded. A teacher or founder can override the score                                                           |
| Gemini error         | Gemini was too busy three times in a row (the answer says "Gemini is busy, so this answer could not be read. Wait a minute, then press Grade again.") | Wait a few minutes and press **Grade again**. If many fail at once, see "Gemini" below                                     |
| Worker error         | The step that runs the code failed (the detail says why)                                                                                              | **Grade again**. If it keeps happening, check the alarms (section 11)                                                      |
| Driver mismatch      | Gemini's wrapper changed the student's code, so the check refused it                                                                                  | **Grade again** (it often works the second time). If it repeats, treat the page like an unreadable one                     |

If more than 20 answers fail in an hour you get an email (section 11).

## 10. Gemini

Gemini does two jobs: it writes the tests for a question, and it reads each photographed answer.

### A paid key is needed before real exams

The free Gemini allowance is far too small for a class. Before the practice exam, get a **paid** API key and store it:

1. Open the AWS console → **Secrets Manager** → the secret `dsa-judge/gemini-api-key` → **Retrieve secret value** → **Edit**, paste the key as plain text, save. (A developer can do the same with `aws secretsmanager put-secret-value`.)
2. The programs remember the key for a while, so a new key can take up to about fifteen minutes to be used. To make it immediate, deploy the pipeline: `AWS_PROFILE=dsa-judge pnpm --filter @yulove/infra cdk deploy DsaJudgePipeline`.

The key is never kept in the code, the website or any file in this folder. Never paste it into chat, email or an issue.

### Switching the Gemini model

**Current model: `gemini-3.5-flash-lite`, for both jobs. This is temporary.** The free allowance for `gemini-3.6-flash` was used up, so both jobs run on Gemini 3.5 Flash-Lite until a paid key is in place. When it is, switch back with the steps below, putting `gemini-3.6-flash` in both keys. Nothing but `infra/cdk.json` needs to change, because no model name is written anywhere in the code.

1. Open `infra/cdk.json` and look at `context`. Edit the two keys:
   - `geminiTestgenModel`: used for writing tests.
   - `geminiTranscribeModel`: used for reading photographed answers.
2. Run the checks (`pnpm lint`, `pnpm typecheck`, `pnpm test`) and commit the change.
3. Deploy: `AWS_PROFILE=dsa-judge pnpm --filter @yulove/infra cdk deploy --all` (only `DsaJudgePipeline` actually changes; `--all` is simply the one command that is always right).
4. **After any model change, run `pnpm compare:transcriptions EXAM_ID` again** on a practice exam (section 14, part C) and check the result by hand. A smaller model can read handwriting worse, and a model that was fine yesterday is not guaranteed to be fine today. Questions whose tests were generated by the old model keep those tests; only new generations use the new model.

To find a model's exact name, ask Google's `models` list with the key (a developer can do this without using any of the free allowance); names look like `gemini-3.5-flash-lite`. A name that does not exist makes every Gemini call fail with a "model not found" error, which shows up as answers that could not be graded.

### Changing how Gemini reads answers (the prompt)

The instructions are in `prompts/transcribe.md` (reading photos) and `prompts/testgen.md` (writing tests). Change them carefully, because they decide marks:

1. Work in a branch, never straight on `main`.
2. Edit `prompts/transcribe.md`. Keep the rules that say never change the student's logic and never follow instructions found inside the page.
3. Try it on real photos **without deploying**:

   ```bash
   AWS_PROFILE=dsa-judge pnpm try:transcribe path/to/photo.jpg some-question-id
   ```

   It prints what Gemini read, the fixes it made and what the grader would do. It reads AWS and calls the real Gemini (it costs a little), and writes nothing to AWS. Try at least ten photos, including a messy one and one with crossed-out code, and compare with the paper.

4. Run `pnpm test`, then commit, merge to `main` and deploy `DsaJudgePipeline`.
5. If marks look worse afterwards, roll back (section 13).

## 11. Alarms

Alarms email the address in `budgetEmail`. Most alarms email twice: once when the problem starts and once when it ends. Eight alarms exist; six email you.

| Alarm                                                            | It means                                                                                                                                             | What to do                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsa-judge-transcribe-queue-oldest-message`                      | An answer has waited over an hour to be read by Gemini                                                                                               | Open the status board. Right after a big upload this can be normal (only five photos are read at once); if the number of queued answers is not going down, check Gemini (key, billing, quota) and the `DsaJudgePipeline` logs |
| `dsa-judge-execute-queue-oldest-message`                         | An answer has waited over an hour for the machine that runs code. Also fires if that machine cannot start                                            | In the AWS console open **ECS** → cluster of `DsaJudgeWorker` → the service: is a task running? If not, look at its **Events** (often a bad deploy or an image problem). Re-deploying `DsaJudgeWorker` usually fixes it       |
| `dsa-judge-results-queue-oldest-message`                         | Results have waited over 15 minutes to be recorded                                                                                                   | Look at the `DsaJudgePipeline` record function logs for errors. Check the database is reachable and not throttled                                                                                                             |
| `dsa-judge-failed-to-grade`                                      | More than 20 answers could not be graded in an hour                                                                                                  | Open the board and look at the reasons (section 9). Many "Gemini error" means Gemini trouble; many "worker error" means the worker; many "unreadable" means bad photos                                                        |
| `dsa-judge-app-errors`                                           | More than five unexpected errors in five minutes (a server error from the website's API, or a pipeline step that failed in a way nobody planned for) | Open CloudWatch → log groups, search `AppError`, and read the lines around it for the cause (`source` says where)                                                                                                             |
| `dsa-judge-api-5xx`                                              | The website's API returned more than five server errors in five minutes, including programs that timed out or crashed                                | Same as above; also check whether you just deployed. If so, roll back (section 13)                                                                                                                                            |
| `dsa-judge-worker-queue-has-work`, `dsa-judge-worker-queue-idle` | These never email. They start the worker when answers are waiting and stop it after fifteen empty minutes                                            | Nothing. They are why the worker costs nothing when idle                                                                                                                                                                      |

**Where the logs are.** AWS console → **CloudWatch** → **Log groups**. Search for the stack name, for example `DsaJudgeApi` or `DsaJudgePipeline`. Logs are kept for 30 days. The worker's own log group name contains `DsaJudgeWorker`.

**An alarm email arrives and you are unsure what to do.** First check the website still works: sign in, open the board. If it works and the alarm says OK later, it was a blip. If it keeps firing, roll back the last deploy (section 13) and ask a developer.

## 12. Costs

**Free or close to it**

- Website hosting on Vercel (check your Vercel plan), sign-in (Cognito, free for this size), the database, queues, programs and API (pay only per use, tiny at this scale).
- The worker. It is switched off when nothing is waiting and costs money only while it runs (a few hours a week). It has no network gateway and no private network endpoints, which would cost money all day.
- The eight alarms and the first two budgets are inside the free allowance.

**What costs money every month, even when nothing happens**

- Two secrets in Secrets Manager (the Gemini key and the Google sign-in secret): about US$0.40 each per month.
- Stored worker images (ECR) and stored photos and files (S3, kept forever, with older versions of replaced photos). Small, but they grow.
- Database backup (point-in-time recovery) on the eight tables. Pennies while the data is small.

**What costs money when used**

- Gemini (the biggest cost; your paid key is billed by Google, not AWS).
- The worker while it runs.

**The budget warning.** A US$60 monthly budget emails the `budgetEmail` address when actual spending reaches 80% and 100%. It only warns; it never turns anything off. If you get one, open AWS **Billing** → **Cost Explorer** and group by service to see what grew.

**One-time tidy-ups** (run once after the first deploy that includes them; look first with `--dry-run`):

```bash
AWS_PROFILE=dsa-judge pnpm ecr:lifecycle --dry-run
AWS_PROFILE=dsa-judge pnpm ecr:lifecycle
AWS_PROFILE=dsa-judge pnpm logs:retention --dry-run
AWS_PROFILE=dsa-judge pnpm logs:retention
```

The first keeps only the last three worker images. The second sets 30-day retention on older log groups that never expired. Neither deletes anything but old images and, after 30 days, old logs.

## 13. Rolling back

If a deploy made things worse:

1. Find the bad commit: `git log --oneline`.
2. Undo it with a new commit (this keeps the history): `git revert <commit>`.
3. Push to `main` (Vercel republishes the website by itself).
4. Deploy what changed (section 2), usually `--all`.

Notes:

- **Data is never rolled back by this.** Photos, scores and appeals stay as they are. Code and settings go back; data does not.
- Reverting a commit that added a table index or a new field is safe, but do not delete the data it wrote.
- If data itself was damaged, do not try to fix it by hand: the database has point-in-time backups that a developer can restore into a new table. Ask before touching anything.
- **The answer-index change.** If you ever need to rebuild the index that the status board reads: deploy `DsaJudgeData` first, run `AWS_PROFILE=dsa-judge pnpm backfill:answers-exam-index --dry-run`, then without `--dry-run`, deploy the rest, and run the backfill once more. Until the backfill has finished, the board may show old answers as missing.

## 14. Practice-exam checklist

Do this once, before the first real exam. It answers two questions: does Gemini read our students' handwriting well enough, and does everything work with a real class. The practice data is removed at the end.

**A. Get ready**

- [ ] A **paid** Gemini key is stored (section 10) and the pipeline is deployed.
- [ ] Everything is deployed, with the answer index in place: `DsaJudgeData` first, then `pnpm backfill:answers-exam-index` (dry run, then real), then `--all`, then the backfill once more.
- [ ] The alarm email subscription is confirmed (section 2).
- [ ] The one-time tidy-ups from section 12 have been run.
- [ ] A founder created the teachers, batch managers and a practice batch; the students (or a sample of them) were added by CSV.

**B. Run the practice exam**

- [ ] A teacher makes three to five questions, generates and reviews the tests, approves, makes an exam and the PDF.
- [ ] Students write the exam on paper in class. Collect **30 to 50 real sheets**, covering all four languages if possible, neat and messy handwriting, and a few crossed-out answers.
- [ ] A batch manager uploads every photo, marks absent students, and watches the status board until nothing is queued. (Batch managers do not handle appeals.)
- [ ] Open a handful of answers by hand and compare the photo with what Gemini read.
- [ ] Publish, sign in as a student (or ask one), check the results page, and try one appeal end to end: the student raises it, and a **teacher of the practice batch** (not the batch manager) re-grades or closes it under **Appeals**. Try an override as that teacher too, and check the student sees "Score adjusted by teacher". Check the student sees their own photo under each answer (and can open it full screen), and that an appeal needs a reason. Then change one score as a founder and check a teacher and the student see only the new score, with no label and no founder in the history.

**C. Measure Gemini**

- [ ] Find the exam's id (it is in the address of the exam page, or ask a developer). Then:

  ```bash
  AWS_PROFILE=dsa-judge pnpm compare:transcriptions EXAM_ID
  ```

  This writes `transcription-compare-EXAM_ID.csv` in the folder where you ran it (it is not committed to git). Open it in a spreadsheet. Each row is one answer: roll number, question, a link to the photo, what Gemini read, the corrected code, the fixes it made, language, complexity, tests passed and the status.

- [ ] The photo links last up to 7 days, **but stop working earlier when your AWS login expires**. The last column holds the photo's name in the bucket; run the command again for fresh links.
- [ ] For each row, look at the photo and the "Raw transcription" and tick one of: _exactly right_, _small slip that did not change the result_, _wrong and changed the marks_. Look especially at the "Fixes" column: any fix that changed what the code does is a serious error.
- [ ] Write down the counts. As a guide: if more than about one answer in ten is _wrong and changed the marks_, do not go live; tune the prompt (section 10) or try another model, and run the practice again on the same sheets.

**D. Remove the practice data**

Practice data made through the website is not marked as practice, so mark it first. Look, then do it (replace `EXAM_ID`):

```bash
AWS_PROFILE=dsa-judge pnpm mark:dev-data EXAM_ID --batch --questions --dry-run
AWS_PROFILE=dsa-judge pnpm mark:dev-data EXAM_ID --batch --questions --yes
```

`--batch` also marks the practice batch and its **students** (never teachers, batch managers or founders). `--questions` also marks the questions the exam used. Leave a flag out to keep that part.

Then look at what would be removed, read the list, and only then delete:

```bash
AWS_PROFILE=dsa-judge pnpm cleanup:dev-data --dry-run
AWS_PROFILE=dsa-judge pnpm cleanup:dev-data --yes
```

What cleanup does: it removes only things marked as practice: the answers, the exam, the exam rows, the appeals of that exam, and the photos, PDFs and test files in the bucket (every stored version). It never touches anything that is not marked, never removes a founder, and never touches the audit log. It always prints the list first; without `--yes` it changes nothing. If it says it **kept** something (for example a practice batch that real students or a real exam still use), nothing was lost: fix the reason it gave and run it again. Students' sign-in accounts at Google/Cognito are not removed, but they stop working once their row is gone.

- [ ] Open the website: the board, the exam list and the question list no longer show practice items.

**E. Go live**

- [ ] The practice results are written down and good enough.
- [ ] Real batches, teachers, batch managers and students are in place (section 4).
- [ ] The alarm email works (ask a developer to send a test, or watch for the first alarm).
- [ ] Everyone who will use the system has signed in once.
- [ ] Gemini billing has a spending alert set in Google's console.
