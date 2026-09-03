# RajDailyTools CBT Engine

A reusable, exam-agnostic Computer-Based Test (CBT) engine built with plain
HTML, CSS and JavaScript. It has no build step and no framework, so it runs
directly on GitHub Pages.

**The core idea:** the engine (`cbt.js`, `style.css`, the three HTML shells)
never mentions a specific exam, subject, section, question, mark value,
duration or negative-marking rule. Everything about an exam lives in JSON
files under `/data/`. To publish a new exam or a new mock for an existing
exam, you edit or add JSON — you never touch `cbt.js`.

```
/index.html          Mock-test selection page (reads data/catalog.json)
/test.html           The CBT exam interface (reads a catalog entry's data)
/result.html         Score + analysis page (reads a saved attempt)
/style.css           All styling, driven by design tokens (CSS variables)
/cbt.js              The engine: loading, scoring, timer, palette, storage
/data/
  catalog.json       Registry of every mock test the site offers
  exam.json          Demo exam config (Mock 01, "split" format)
  questions.json     Demo question bank (Mock 01)
  rdt-demo/
    mock-02.json     A second demo mock using the "combined" format
/assets/             Put logos/images here
```

---

## 1. How the pieces fit together

1. **`data/catalog.json`** is the master list of every test on the site.
   `index.html` reads only this file to draw the test cards.
2. Each catalog entry points at either:
   - **`"format": "split"`** — separate `configPath` (exam settings) and
     `questionsPath` (question bank) files, like the demo Mock 01
     (`data/exam.json` + `data/questions.json`), **or**
   - **`"format": "combined"`** — one `combinedPath` file containing both
     `{ "exam": {...}, "questions": [...] }`, like Mock 02
     (`data/rdt-demo/mock-02.json`).
   Both formats are fully supported by the same engine — pick whichever is
   more convenient for a given exam. The `/data/boi/mock-01.json`,
   `/data/boi/mock-02.json` style of organisation from the original brief
   maps onto the "combined" format (one file per mock).
3. **`test.html?test=<testId>`** looks up `<testId>` in the catalog, loads
   its exam config + questions, and runs the full timed exam experience.
4. On submit, the engine computes the score entirely from `exam.json`'s
   rules (see §4) and saves a **self-contained result object** to
   `localStorage` (it embeds a copy of every question, so `result.html`
   never needs to re-fetch exam data).
5. **`result.html?resultId=<attemptId>`** reads that result and renders the
   score, section/topic breakdowns and full question review.

---

## 2. How to add a new exam

1. Duplicate `data/exam.json` and `data/questions.json` into a new folder,
   e.g. `data/ssc-mts/mock-01-exam.json` and
   `data/ssc-mts/mock-01-questions.json` — or write one combined file, e.g.
   `data/ssc-mts/mock-01.json`, containing `{ "exam": {...}, "questions": [...] }`.
2. Edit the exam configuration fields (name, sections, marks, duration,
   etc. — see §6 for the full field reference).
3. Write the question bank for that exam (see §3).
4. Add an entry to `data/catalog.json` pointing at the new file(s):

   ```json
   {
     "testId": "ssc-mts-mock01",
     "displayName": "SSC MTS Mock Test 01",
     "organization": "Staff Selection Commission",
     "format": "combined",
     "combinedPath": "data/ssc-mts/mock-01.json",
     "isPaid": false,
     "isLocked": false,
     "summary": { "totalQuestions": 100, "totalMarks": 100, "durationMinutes": 90 }
   }
   ```

5. That's it — the new exam appears automatically on the home page, and
   `test.html?test=ssc-mts-mock01` runs it with the exact same engine.
   **No JavaScript changes are required.**

## 3. How to add questions

Add objects to the `questions` array (see the field reference in §6). Each
question must reference a `section` id that exists in that exam's
`sections` array — the engine groups, orders and colour-codes the question
palette by matching `question.section` to `exam.sections[].id`.

Tips:
- Keep `id` values unique within a question bank (e.g. `q1`, `q2`, …).
- `marks` and `negativeMarks` on a question are optional — if omitted, the
  engine falls back to the section's `marksPerQuestion` / `negativeMarking`,
  and then to the exam's defaults. This lets you have one exam where every
  question uses the same rule, or one where a handful of questions carry
  bonus marks — no code changes either way.
- `hi` (Hindi) fields are optional. If a question only has `en`, the
  language switcher will simply keep showing English for that question.

## 4. How to change exam configuration (marks, duration, negative marking…)

Everything lives in `exam.json` (or the `exam` key of a combined file):

- **Duration**: `durationMinutes` — the countdown starts from this the
  moment the candidate clicks "Start Test".
- **Marks per question**: set `defaultMarksPerQuestion` for the whole exam,
  or override per section via `sections[].marksPerQuestion`, or per
  question via `questions[].marks`.
- **Negative marking**: set the exam-level `negativeMarking` object:
  ```json
  "negativeMarking": { "enabled": true, "mode": "fraction", "value": 0.25 }
  ```
  - `"mode": "none"` or `"enabled": false` → no negative marking at all.
  - `"mode": "fixed"` → `value` is a flat deduction per wrong answer
    (e.g. always -0.5 marks).
  - `"mode": "fraction"` → deduction = `value × marks for that question`
    (the classic "¼ mark" rule).
  A section can override this exam-level rule with its own
  `sections[].negativeMarking` object (see the English section in the demo
  exam, which disables negative marking while the other three sections keep
  it). A question can override both by setting `questions[].negativeMarks`
  directly to an absolute number.
- **Sections**: the `sections` array fully controls the section tabs, the
  question palette groupings, and how many questions belong to each
  section. Reorder, rename, add or remove sections freely — nothing in
  `cbt.js` assumes a fixed count or fixed names.
- **Features**: toggle the calculator, notepad, fullscreen prompt, language
  switch, font-size controls, theme switch, and whether candidates may jump
  freely between sections, via the `features` object.
- **Result page**: toggle which analysis blocks appear via `resultSettings`
  (section-wise, topic-wise, question review, explanations).

## 5. How to create Mock 2, Mock 3, etc. for the same exam

Simplest path: copy an existing mock's file(s), change `mockId`/`examName`
(e.g. add "- Mock 03"), swap in a fresh question set, and add one more
entry to `data/catalog.json` with a new `testId`. Each mock is independent
in storage — a candidate's progress on Mock 01 never touches Mock 02.

## 6. JSON field reference

### Exam configuration (`exam.json` / the `exam` key)

| Field | Required | Notes |
|---|---|---|
| `examId` | yes | Stable identifier for the exam family |
| `examName` | yes | String, or `{ "en": "...", "hi": "..." }` |
| `organization` | no | Shown in the header and instructions |
| `year` | no | Cosmetic |
| `totalMarks` | yes | Shown in instructions; the true max is still computed from questions |
| `durationMinutes` | yes | Countdown length |
| `languages` | yes | Array like `["en","hi"]`; drives the language switcher |
| `defaultLanguage` | no | Defaults to `languages[0]` |
| `defaultMarksPerQuestion` | yes | Fallback when a section/question doesn't specify marks |
| `negativeMarking` | yes | `{ enabled, mode: "none"\|"fixed"\|"fraction", value }` |
| `sections` | yes | Array of `{ id, name, questionCount, marksPerQuestion?, negativeMarking? }` |
| `features` | no | Booleans: `calculatorEnabled`, `notepadEnabled`, `fullscreenMode`, `languageSwitchEnabled`, `fontSizeControlEnabled`, `themeSwitchEnabled`, `sectionSwitchingAllowed` |
| `resultSettings` | no | Booleans: `showSectionWise`, `showTopicWise`, `showQuestionReview`, `showExplanations` |
| `access` | no | `{ isPaid, requiresUnlock }` — see §7 |
| `instructions` | no | `{ "en": [ "...", "..." ], "hi": [ ... ] }` |

### Question (`questions.json` / the `questions` array)

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique within the question bank |
| `section` | yes | Must match a `sections[].id` in the exam config |
| `subject` | no | Free text, cosmetic |
| `topic` | no | Used for the topic-wise result breakdown |
| `difficulty` | no | Free text (e.g. `easy`/`medium`/`hard`), shown as a pill |
| `questionText` | yes | String, or `{ "en": "...", "hi": "..." }` |
| `options` | yes | Array of `{ id, text }`, `text` may be bilingual |
| `correctAnswer` | yes | Must match one `options[].id` |
| `explanation` | no | String or bilingual map, shown on the result page |
| `marks` | no | Overrides the section/exam default for this question only |
| `negativeMarks` | no | Absolute override — bypasses the exam's `negativeMarking` rule entirely for this question |

### Catalog entry (`data/catalog.json`)

| Field | Required | Notes |
|---|---|---|
| `testId` | yes | Used in the `test.html?test=` URL and as the storage key |
| `displayName` | yes | Shown on the home-page card |
| `organization` | no | Shown on the card |
| `format` | yes | `"split"` or `"combined"` |
| `configPath` / `questionsPath` | required if `format: "split"` | Paths to the two JSON files |
| `combinedPath` | required if `format: "combined"` | Path to the single JSON file |
| `isPaid` / `isLocked` | no | Drives the paid-access placeholder (see §7) |
| `summary` | no | `{ totalQuestions, totalMarks, durationMinutes }` shown on the card without an extra fetch |

---

## 7. Paid tests and answer security — read this before charging money

**Client-side JavaScript cannot securely hide anything.** Anyone can open
DevTools, read `cbt.js`, and view the question JSON directly — including
`correctAnswer`. The `isLocked` / `isPaid` flags and the `AccessControl`
module in `cbt.js` only prevent *accidental* access from the UI; they are
**not** a security boundary, and the code says so in a comment above
`AccessControl.checkAccess`.

To sell real paid mocks, you need a backend that:
1. Verifies payment and issues a signed session token.
2. Serves the question JSON (or at minimum the answer key) only to requests
   carrying a valid token.
3. Grades submissions **server-side**, so the answer key never has to reach
   a browser that hasn't paid.

`AccessControl.checkAccess()` is written as the single place to swap in
that real check later — replace its body with a call to your API and
nothing else in the engine needs to change.

This repository intentionally does **not** implement any fake payment
flow. `isLocked: true` mocks simply show a message explaining that paid
access is coming once a backend exists (see `data/rdt-demo/mock-02.json`
in `data/catalog.json` for a working example of a locked card).

---

## 8. Deploying to GitHub Pages

1. Push this folder to a GitHub repository (the files must sit at the
   repository root, or in `/docs` if you configure Pages that way).
2. In the repository settings, enable **GitHub Pages** and point it at the
   branch/folder containing `index.html`.
3. Wait for the Pages build to finish, then open the published URL — the
   site is entirely static, so there's nothing else to configure.
4. To publish a new exam or mock later: add/replace files under `data/`,
   update `data/catalog.json`, and push. No rebuild step, no server.

---

## 9. Known limitations (by design, for a static GitHub Pages deployment)

- Progress and results are stored in the browser's `localStorage`, so they
  are per-device/per-browser and are lost if the user clears site data.
  There is no login and no cross-device sync — that requires a backend.
- Because there's no backend, question data (including answers) is always
  publicly readable by anyone who opens the browser's network tab. See §7.
- The calculator is a simple four-function calculator (no memory, no
  scientific functions) — extend `TestController.buildCalculator()` in
  `cbt.js` if you need more, but note this is one of the few places a
  change to `cbt.js` is expected, since it's a generic UI tool, not
  exam-specific logic.
