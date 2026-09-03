/*!
 * RajDailyTools CBT Engine — cbt.js
 * ---------------------------------------------------------------------------
 * A reusable, exam-agnostic Computer Based Test engine.
 *
 * HARD RULE FOR THIS FILE: nothing below may hard-code an exam name, subject,
 * section, question, mark value, duration or negative-marking rule. All of
 * that comes from /data/*.json at runtime. To point the engine at a
 * different exam, replace the JSON files (or add a new entry to
 * data/catalog.json) — never edit this file.
 *
 * The file is organised into independent modules:
 *   Utils            - small generic helpers
 *   CBTStorage        - localStorage persistence, namespaced per test
 *   CBTLoader         - fetches + normalises exam/question JSON
 *   AccessControl     - placeholder paid-access gate (see comments inside)
 *   CBTScoring        - marks / negative-marks resolution + scoring
 *   CBTTimer          - wall-clock-accurate countdown
 *   CBTSession        - in-memory session/state manager for a test attempt
 *   HomeController    - drives index.html
 *   TestController    - drives test.html
 *   ResultController  - drives result.html
 *
 * Only one controller runs per page, selected via document.body.dataset.page.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ===========================================================================
   * Utils
   * =========================================================================== */
  const Utils = {
    qs(sel, root) { return (root || document).querySelector(sel); },
    qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },

    el(tag, attrs, children) {
      const node = document.createElement(tag);
      attrs = attrs || {};
      Object.keys(attrs).forEach((key) => {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key.indexOf('on') === 0 && typeof attrs[key] === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else node.setAttribute(key, attrs[key]);
      });
      (children || []).forEach((c) => { if (c) node.appendChild(c); });
      return node;
    },

    getParam(name) {
      return new URLSearchParams(window.location.search).get(name);
    },

    formatSeconds(totalSeconds) {
      const s = Math.max(0, Math.floor(totalSeconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    },

    formatDuration(totalSeconds) {
      const s = Math.max(0, Math.round(totalSeconds));
      const m = Math.floor(s / 60);
      const sec = s % 60;
      if (m <= 0) return `${sec}s`;
      return `${m}m ${sec}s`;
    },

    round(num, dp) {
      const f = Math.pow(10, dp === undefined ? 2 : dp);
      return Math.round((num + Number.EPSILON) * f) / f;
    },

    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str === undefined || str === null ? '' : String(str);
      return div.innerHTML;
    },

    localizedText(field, lang) {
      // Accepts either a plain string or a { en, hi, ... } map. Falls back
      // gracefully if the requested language is missing, so the engine never
      // breaks when a JSON file only ships one language.
      if (field === undefined || field === null) return '';
      if (typeof field === 'string') return field;
      return field[lang] || field.en || Object.values(field)[0] || '';
    },

    toast(message, ms) {
      let el = Utils.qs('#cbt-toast');
      if (!el) {
        el = Utils.el('div', { id: 'cbt-toast', class: 'toast' });
        document.body.appendChild(el);
      }
      el.textContent = message;
      el.classList.add('is-visible');
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => el.classList.remove('is-visible'), ms || 2600);
    },
  };

  /* ===========================================================================
   * CBTStorage — localStorage persistence
   * All keys are namespaced by testId so multiple exams/mocks never collide.
   * =========================================================================== */
  const CBTStorage = {
    PREFIX: 'rdtcbt:',

    _read(key) {
      try {
        const raw = localStorage.getItem(this.PREFIX + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.error('CBTStorage read failed for', key, e);
        return null;
      }
    },
    _write(key, value) {
      try {
        localStorage.setItem(this.PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.error('CBTStorage write failed for', key, e);
        return false;
      }
    },
    _remove(key) {
      try { localStorage.removeItem(this.PREFIX + key); } catch (e) { /* noop */ }
    },

    getSession(testId) { return this._read(`session:${testId}`); },
    saveSession(testId, session) { return this._write(`session:${testId}`, session); },
    clearSession(testId) { this._remove(`session:${testId}`); },

    saveResult(resultId, result) { return this._write(`result:${resultId}`, result); },
    getResult(resultId) { return this._read(`result:${resultId}`); },

    getPref(name, fallback) {
      const v = this._read(`pref:${name}`);
      return v === null || v === undefined ? fallback : v;
    },
    setPref(name, value) { return this._write(`pref:${name}`, value); },
  };

  /* ===========================================================================
   * CBTLoader — fetches exam config + questions, and normalises the two
   * supported data-file shapes ("split" and "combined") into one internal
   * model: { examConfig, questions }.
   * =========================================================================== */
  const CBTLoader = {
    async fetchJSON(path) {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
      return res.json();
    },

    async loadCatalog() {
      return this.fetchJSON('data/catalog.json');
    },

    findTestEntry(catalog, testId) {
      return (catalog.tests || []).find((t) => t.testId === testId) || null;
    },

    /**
     * Loads exam config + questions for a catalog entry, regardless of
     * whether it uses the "split" (exam.json + questions.json) or
     * "combined" (single file with { exam, questions }) format. This is
     * what lets /data/exam.json + /data/questions.json AND single-file
     * mocks like /data/boi/mock-01.json both work through the same engine.
     */
    async loadTestData(entry) {
      if (entry.format === 'combined') {
        const data = await this.fetchJSON(entry.combinedPath);
        return { examConfig: data.exam, questions: data.questions || [] };
      }
      // default / "split" format
      const [examConfig, questionsDoc] = await Promise.all([
        this.fetchJSON(entry.configPath),
        this.fetchJSON(entry.questionsPath),
      ]);
      const questions = Array.isArray(questionsDoc) ? questionsDoc : (questionsDoc.questions || []);
      return { examConfig, questions };
    },

    /** Returns questions ordered to match examConfig.sections, dropping any
     * question whose section id isn't declared in the config (defensive —
     * keeps a stray/mislabeled question from breaking the whole test). */
    orderQuestionsBySections(examConfig, questions) {
      const sectionIds = (examConfig.sections || []).map((s) => s.id);
      const bySection = {};
      questions.forEach((q) => {
        if (!bySection[q.section]) bySection[q.section] = [];
        bySection[q.section].push(q);
      });
      const ordered = [];
      sectionIds.forEach((sid) => { (bySection[sid] || []).forEach((q) => ordered.push(q)); });
      return ordered;
    },
  };

  /* ===========================================================================
   * AccessControl — placeholder for paid-test gating.
   *
   * IMPORTANT: client-side JavaScript can never securely hide correct
   * answers or truly enforce payment — anyone can read this file's source.
   * For a real paid product, add a backend that:
   *   1. Issues a signed session token after verifying payment.
   *   2. Serves question JSON (or at least the correct-answer key) only to
   *      requests carrying a valid token, and grades submissions server-side.
   * Until that backend exists, this module only prevents *accidental* access
   * to locked demo tests in the UI — it is NOT a security boundary.
   * =========================================================================== */
  const AccessControl = {
    checkAccess(testEntry) {
      const access = testEntry.access || { isPaid: testEntry.isPaid, requiresUnlock: testEntry.isLocked };
      if (!testEntry.isLocked && !access.requiresUnlock) return { allowed: true };
      // TODO(backend): replace this stub with a real entitlement check,
      // e.g. `return api.verifyPurchase(testEntry.testId)`.
      return { allowed: false, reason: 'locked', message: 'This mock test requires a purchase. Paid access and server-side answer validation will be enabled once the RajDailyTools backend is connected.' };
    },
  };

  /* ===========================================================================
   * CBTScoring — resolves marks/negative-marks and scores a full attempt.
   * Precedence for both marks and negative marking is:
   *   question-level override  >  section-level setting  >  exam-level default
   * =========================================================================== */
  const CBTScoring = {
    resolveMarks(question, section, examConfig) {
      if (typeof question.marks === 'number') return question.marks;
      if (section && typeof section.marksPerQuestion === 'number') return section.marksPerQuestion;
      return examConfig.defaultMarksPerQuestion || 1;
    },

    resolveNegativeMarks(question, section, examConfig, marks) {
      if (typeof question.negativeMarks === 'number') return question.negativeMarks;
      const negConfig = (section && section.negativeMarking) ? section.negativeMarking : examConfig.negativeMarking;
      if (!negConfig || !negConfig.enabled || negConfig.mode === 'none') return 0;
      if (negConfig.mode === 'fixed') return negConfig.value || 0;
      if (negConfig.mode === 'fraction') return Utils.round((negConfig.value || 0) * marks, 4);
      return 0;
    },

    findSection(examConfig, sectionId) {
      return (examConfig.sections || []).find((s) => s.id === sectionId) || null;
    },

    /**
     * Scores one attempt. `answers` is a map of questionId -> selected
     * option id. Returns a fully self-contained result object (it embeds a
     * snapshot of each question) so result.html never needs to re-fetch
     * exam data to render the review screen.
     */
    scoreAttempt(examConfig, questions, answers, marked) {
      const perQuestion = [];
      const sectionAgg = {};
      const topicAgg = {};

      let correct = 0, wrong = 0, unattempted = 0, scoreObtained = 0, maxMarks = 0;

      questions.forEach((q) => {
        const section = this.findSection(examConfig, q.section);
        const marks = this.resolveMarks(q, section, examConfig);
        const negMarks = this.resolveNegativeMarks(q, section, examConfig, marks);
        const chosen = answers[q.id];
        let status, marksAwarded;

        if (chosen === undefined || chosen === null || chosen === '') {
          status = 'unattempted'; marksAwarded = 0; unattempted += 1;
        } else if (chosen === q.correctAnswer) {
          status = 'correct'; marksAwarded = marks; correct += 1;
        } else {
          status = 'wrong'; marksAwarded = -negMarks; wrong += 1;
        }

        scoreObtained += marksAwarded;
        maxMarks += marks;

        const sectionName = section ? Utils.localizedText(section.name, 'en') : q.section;
        if (!sectionAgg[q.section]) {
          sectionAgg[q.section] = { sectionId: q.section, name: sectionName, total: 0, attempted: 0, correct: 0, wrong: 0, unattempted: 0, scoreObtained: 0, maxMarks: 0 };
        }
        const sAgg = sectionAgg[q.section];
        sAgg.total += 1;
        sAgg.maxMarks += marks;
        sAgg.scoreObtained += marksAwarded;
        if (status !== 'unattempted') sAgg.attempted += 1;
        if (status === 'correct') sAgg.correct += 1;
        if (status === 'wrong') sAgg.wrong += 1;
        if (status === 'unattempted') sAgg.unattempted += 1;

        const topicKey = q.topic || 'General';
        if (!topicAgg[topicKey]) {
          topicAgg[topicKey] = { topic: topicKey, total: 0, correct: 0, wrong: 0, unattempted: 0, scoreObtained: 0, maxMarks: 0 };
        }
        const tAgg = topicAgg[topicKey];
        tAgg.total += 1;
        tAgg.maxMarks += marks;
        tAgg.scoreObtained += marksAwarded;
        if (status === 'correct') tAgg.correct += 1;
        if (status === 'wrong') tAgg.wrong += 1;
        if (status === 'unattempted') tAgg.unattempted += 1;

        perQuestion.push({
          questionId: q.id,
          section: q.section,
          sectionName,
          topic: q.topic,
          difficulty: q.difficulty,
          status,
          isMarked: !!(marked && marked[q.id]),
          chosenOptionId: chosen || null,
          correctOptionId: q.correctAnswer,
          marks,
          negativeMarks: negMarks,
          marksAwarded: Utils.round(marksAwarded, 2),
          question: q, // full snapshot for the review screen
        });
      });

      const attempted = correct + wrong;
      const accuracyPercent = attempted > 0 ? Utils.round((correct / attempted) * 100, 1) : 0;

      return {
        totalQuestions: questions.length,
        attempted,
        correct,
        wrong,
        unattempted,
        scoreObtained: Utils.round(scoreObtained, 2),
        maxMarks: Utils.round(maxMarks, 2),
        accuracyPercent,
        sectionWise: Object.values(sectionAgg).map((s) => ({ ...s, scoreObtained: Utils.round(s.scoreObtained, 2), maxMarks: Utils.round(s.maxMarks, 2) })),
        topicWise: Object.values(topicAgg).map((t) => ({ ...t, scoreObtained: Utils.round(t.scoreObtained, 2), maxMarks: Utils.round(t.maxMarks, 2) })),
        perQuestion,
      };
    },
  };

  /* ===========================================================================
   * CBTTimer — wall-clock-accurate countdown.
   * Stores an absolute `endTimestamp` (epoch ms) rather than a remaining
   * counter, so a refresh, a closed tab, or a slow device never desyncs the
   * remaining time — it's always recomputed from Date.now().
   * =========================================================================== */
  function createTimer(endTimestamp, onTick, onExpire) {
    let intervalId = null;

    function tick() {
      const remainingMs = endTimestamp - Date.now();
      if (remainingMs <= 0) {
        stop();
        onTick(0);
        onExpire();
        return;
      }
      onTick(Math.ceil(remainingMs / 1000));
    }

    function start() {
      tick();
      intervalId = setInterval(tick, 1000);
    }
    function stop() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    }

    return { start, stop, getEndTimestamp: () => endTimestamp };
  }

  /* ===========================================================================
   * CBTSession — the in-memory state manager for one test attempt.
   * Wraps everything TestController needs: question order, per-question
   * status, answers, marks-for-review, current position and language.
   * =========================================================================== */
  const STATUS = {
    NOT_VISITED: 'not-visited',
    NOT_ANSWERED: 'not-answered',
    ANSWERED: 'answered',
    MARKED: 'marked',
    ANSWERED_MARKED: 'answered-marked',
  };

  function createSession(examConfig, questions, testId, existing) {
    const state = existing || {
      testId,
      answers: {},
      marked: {},
      visited: {},
      currentIndex: 0,
      language: examConfig.defaultLanguage || (examConfig.languages && examConfig.languages[0]) || 'en',
      notepad: '',
      startedAt: Date.now(),
      endTimestamp: Date.now() + (examConfig.durationMinutes || 30) * 60000,
      status: 'in-progress',
    };

    function statusFor(qid) {
      const answered = state.answers[qid] !== undefined && state.answers[qid] !== null && state.answers[qid] !== '';
      const isMarked = !!state.marked[qid];
      if (isMarked && answered) return STATUS.ANSWERED_MARKED;
      if (isMarked) return STATUS.MARKED;
      if (answered) return STATUS.ANSWERED;
      if (state.visited[qid]) return STATUS.NOT_ANSWERED;
      return STATUS.NOT_VISITED;
    }

    function visit(qid) { state.visited[qid] = true; }

    function setAnswer(qid, optionId) { state.answers[qid] = optionId; }
    function clearAnswer(qid) { delete state.answers[qid]; }
    function toggleMark(qid) { state.marked[qid] = !state.marked[qid]; }

    function counts(questionIds) {
      const c = { total: questionIds.length, answered: 0, notAnswered: 0, marked: 0, notVisited: 0 };
      questionIds.forEach((qid) => {
        const st = statusFor(qid);
        if (st === STATUS.ANSWERED || st === STATUS.ANSWERED_MARKED) c.answered += 1;
        if (st === STATUS.MARKED || st === STATUS.ANSWERED_MARKED) c.marked += 1;
        if (st === STATUS.NOT_ANSWERED) c.notAnswered += 1;
        if (st === STATUS.NOT_VISITED) c.notVisited += 1;
      });
      return c;
    }

    return { state, statusFor, visit, setAnswer, clearAnswer, toggleMark, counts };
  }

  /* ===========================================================================
   * Shared UI prefs (theme / font-size) — global across the whole site, not
   * per test attempt.
   * =========================================================================== */
  const Prefs = {
    applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      CBTStorage.setPref('theme', theme);
    },
    initTheme() {
      const saved = CBTStorage.getPref('theme', 'light');
      this.applyTheme(saved);
      return saved;
    },
    applyFontScale(px) {
      document.documentElement.style.setProperty('--fs-base', px + 'px');
      CBTStorage.setPref('fontSize', px);
    },
    initFontScale() {
      const saved = CBTStorage.getPref('fontSize', 16);
      this.applyFontScale(saved);
      return saved;
    },
  };

  /* ===========================================================================
   * HomeController — drives index.html (mock-test selection page)
   * =========================================================================== */
  const HomeController = {
    async init() {
      Prefs.initTheme();
      Prefs.initFontScale();
      const grid = Utils.qs('#test-grid');
      if (!grid) return;
      try {
        const catalog = await CBTLoader.loadCatalog();
        const tests = catalog.tests || [];
        if (!tests.length) {
          grid.innerHTML = '';
          grid.appendChild(Utils.el('div', { class: 'empty-state', text: 'No mock tests are published yet. Check back soon.' }));
          return;
        }
        grid.innerHTML = '';
        tests.forEach((entry) => grid.appendChild(this.renderCard(entry)));
      } catch (err) {
        console.error(err);
        grid.innerHTML = '';
        grid.appendChild(Utils.el('div', { class: 'error-state', text: 'Could not load the test catalog. Please refresh the page.' }));
      }
    },

    renderCard(entry) {
      const session = CBTStorage.getSession(entry.testId);
      const inProgress = session && session.status === 'in-progress';
      const summary = entry.summary || {};
      const access = AccessControl.checkAccess(entry);

      const badge = !access.allowed
        ? Utils.el('span', { class: 'badge badge--locked', text: '\uD83D\uDD12 Locked' })
        : (inProgress
          ? Utils.el('span', { class: 'badge badge--progress', text: 'In progress' })
          : Utils.el('span', { class: 'badge badge--free', text: 'Free' }));

      const meta = Utils.el('div', { class: 'test-card__meta' }, [
        Utils.el('div', {}, [Utils.el('span', { class: 'num', text: summary.totalQuestions || '—' }), Utils.el('span', { class: 'lbl', text: 'Questions' })]),
        Utils.el('div', {}, [Utils.el('span', { class: 'num', text: summary.totalMarks || '—' }), Utils.el('span', { class: 'lbl', text: 'Marks' })]),
        Utils.el('div', {}, [Utils.el('span', { class: 'num', text: (summary.durationMinutes || '—') + 'm' }), Utils.el('span', { class: 'lbl', text: 'Duration' })]),
      ]);

      const primaryBtn = Utils.el('a', {
        class: 'btn btn--primary btn--block',
        href: access.allowed ? `test.html?test=${encodeURIComponent(entry.testId)}` : '#',
        text: access.allowed ? (inProgress ? 'Resume Test' : 'Start Test') : 'Locked',
      });
      if (!access.allowed) {
        primaryBtn.classList.add('btn--outline');
        primaryBtn.classList.remove('btn--primary');
        primaryBtn.addEventListener('click', (e) => {
          e.preventDefault();
          Utils.toast(access.message);
        });
      }

      return Utils.el('div', { class: 'test-card' }, [
        Utils.el('div', { class: 'test-card__top' }, [
          Utils.el('div', {}, [
            Utils.el('h3', { class: 'test-card__title', text: entry.displayName }),
            Utils.el('div', { class: 'test-card__org', text: entry.organization }),
          ]),
          badge,
        ]),
        meta,
        Utils.el('div', { class: 'test-card__actions' }, [primaryBtn]),
      ]);
    },
  };

  /* ===========================================================================
   * TestController — drives test.html (the CBT exam interface)
   * =========================================================================== */
  const TestController = {
    DEFAULT_TEST_ID: 'rdt-demo-mock01', // page-level convenience default only;
    // this is wiring for the demo entry point, not exam logic baked into the engine.

    examConfig: null,
    questions: [],
    session: null,
    entry: null,
    timer: null,

    async init() {
      Prefs.initTheme();
      Prefs.initFontScale();
      const testId = Utils.getParam('test') || this.DEFAULT_TEST_ID;

      let catalog;
      try {
        catalog = await CBTLoader.loadCatalog();
      } catch (err) {
        this.renderFatalError('Could not load the test catalog.');
        return;
      }
      const entry = CBTLoader.findTestEntry(catalog, testId);
      if (!entry) { this.renderFatalError('This mock test could not be found.'); return; }

      const access = AccessControl.checkAccess(entry);
      if (!access.allowed) { this.renderLocked(access.message); return; }

      this.entry = entry;
      try {
        const { examConfig, questions } = await CBTLoader.loadTestData(entry);
        this.examConfig = examConfig;
        this.questions = CBTLoader.orderQuestionsBySections(examConfig, questions);
      } catch (err) {
        console.error(err);
        this.renderFatalError('Could not load the exam data for this test.');
        return;
      }

      document.title = `${Utils.localizedText(this.examConfig.examName, 'en')} — RajDailyTools`;

      const existing = CBTStorage.getSession(testId);
      if (existing && existing.status === 'in-progress') {
        this.showResumeModal(existing);
      } else {
        this.showInstructionsModal();
      }
    },

    renderFatalError(message) {
      const root = Utils.qs('#test-root');
      root.innerHTML = '';
      root.appendChild(Utils.el('div', { class: 'error-state' }, [
        Utils.el('p', { text: message }),
        Utils.el('a', { class: 'btn btn--primary', href: 'index.html', text: 'Back to test list' }),
      ]));
    },

    renderLocked(message) {
      const root = Utils.qs('#test-root');
      root.innerHTML = '';
      root.appendChild(Utils.el('div', { class: 'error-state' }, [
        Utils.el('p', { text: '\uD83D\uDD12 ' + message }),
        Utils.el('a', { class: 'btn btn--primary', href: 'index.html', text: 'Back to test list' }),
      ]));
    },

    showResumeModal(existing) {
      const overlay = Utils.qs('#modal-resume');
      overlay.hidden = false;
      Utils.qs('#resume-exam-name', overlay).textContent = Utils.localizedText(this.examConfig.examName, 'en');
      const remaining = Math.max(0, Math.round((existing.endTimestamp - Date.now()) / 1000));
      Utils.qs('#resume-time-left', overlay).textContent = Utils.formatSeconds(remaining);
      const c = createSession(this.examConfig, this.questions, this.entry.testId, existing).counts(this.questions.map((q) => q.id));
      Utils.qs('#resume-progress', overlay).textContent = `${c.answered} answered, ${c.marked} marked, ${c.notVisited} not visited`;

      Utils.qs('#btn-resume-continue', overlay).onclick = () => {
        overlay.hidden = true;
        this.startSession(existing);
      };
      Utils.qs('#btn-resume-restart', overlay).onclick = () => {
        overlay.hidden = true;
        CBTStorage.clearSession(this.entry.testId);
        this.showInstructionsModal();
      };
    },

    showInstructionsModal() {
      const overlay = Utils.qs('#modal-instructions');
      overlay.hidden = false;
      Utils.qs('#inst-exam-name', overlay).textContent = Utils.localizedText(this.examConfig.examName, 'en');
      Utils.qs('#inst-exam-meta', overlay).textContent =
        `${this.examConfig.organization || ''} • ${this.questions.length} Questions • ${this.examConfig.totalMarks} Marks • ${this.examConfig.durationMinutes} Minutes`;

      const list = Utils.qs('#inst-list', overlay);
      list.innerHTML = '';
      const lang = this.examConfig.defaultLanguage || 'en';
      const items = (this.examConfig.instructions && this.examConfig.instructions[lang]) || [];
      items.forEach((t) => list.appendChild(Utils.el('li', { text: t })));

      const langSelect = Utils.qs('#inst-language', overlay);
      langSelect.innerHTML = '';
      (this.examConfig.languages || ['en']).forEach((code) => {
        const label = code === 'hi' ? 'हिन्दी (Hindi)' : code === 'en' ? 'English' : code;
        langSelect.appendChild(Utils.el('option', { value: code, text: label }));
      });
      langSelect.value = this.examConfig.defaultLanguage || this.examConfig.languages[0];
      langSelect.onchange = () => {
        list.innerHTML = '';
        const arr = (this.examConfig.instructions && this.examConfig.instructions[langSelect.value]) || [];
        arr.forEach((t) => list.appendChild(Utils.el('li', { text: t })));
      };

      const agree = Utils.qs('#inst-agree', overlay);
      const startBtn = Utils.qs('#btn-start-test', overlay);
      agree.checked = false;
      startBtn.disabled = true;
      agree.onchange = () => { startBtn.disabled = !agree.checked; };

      startBtn.onclick = () => {
        overlay.hidden = true;
        const fresh = createSession(this.examConfig, this.questions, this.entry.testId, null).state;
        fresh.language = langSelect.value;
        this.startSession(fresh);
        if (this.examConfig.features && this.examConfig.features.fullscreenMode) {
          this.tryEnterFullscreen();
        }
      };
    },

    tryEnterFullscreen() {
      const docEl = document.documentElement;
      const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.msRequestFullscreen;
      if (req) { try { req.call(docEl); } catch (e) { /* ignore — not fatal */ } }
    },
    exitFullscreenIfActive() {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) { try { exit.call(document); } catch (e) { /* ignore */ } }
      }
    },

    startSession(state) {
      this.session = createSession(this.examConfig, this.questions, this.entry.testId, state);
      this.persist();
      this.buildShell();
      this.renderAll();
      this.startTimer();
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    },

    beforeUnloadHandler(e) {
      e.preventDefault();
      e.returnValue = '';
    },

    persist() {
      CBTStorage.saveSession(this.entry.testId, this.session.state);
    },

    startTimer() {
      const header = Utils.qs('#timer-box');
      this.timer = createTimer(
        this.session.state.endTimestamp,
        (remainingSec) => {
          Utils.qs('#timer-value').textContent = Utils.formatSeconds(remainingSec);
          header.classList.toggle('is-warning', remainingSec <= 120 && remainingSec > 0);
        },
        () => {
          Utils.toast("Time's up — submitting your test automatically.");
          setTimeout(() => this.submitTest(true), 900);
        }
      );
      this.timer.start();
    },

    /* ---- Shell construction (built once per attempt) ---- */
    buildShell() {
      const root = Utils.qs('#test-root');
      root.innerHTML = '';

      const cfg = this.examConfig;
      const header = Utils.el('header', { class: 'exam-header' }, [
        Utils.el('button', { class: 'icon-btn', id: 'btn-toggle-sidebar', 'aria-label': 'Toggle question palette', text: '\u2630' }),
        Utils.el('div', { class: 'exam-header__title' }, [
          Utils.el('div', { class: 'exam-name', text: Utils.localizedText(cfg.examName, 'en') }),
          Utils.el('div', { class: 'exam-org', text: `${cfg.organization || ''} ${cfg.year || ''}` }),
        ]),
        Utils.el('div', { class: 'exam-header__timer', id: 'timer-box' }, [
          Utils.el('span', { class: 'timer-label', text: 'Time left' }),
          Utils.el('span', { class: 'timer-value', id: 'timer-value', text: '--:--' }),
        ]),
        Utils.el('div', { class: 'exam-header__tools', id: 'header-tools' }),
      ]);

      const sectionTabs = Utils.el('div', { class: 'section-tabs', id: 'section-tabs' });
      const questionScroll = Utils.el('div', { class: 'question-scroll', id: 'question-scroll' });
      const toolbar = Utils.el('div', { class: 'exam-toolbar' }, [
        Utils.el('button', { class: 'btn btn--outline', id: 'btn-mark-review', text: 'Mark for Review' }),
        Utils.el('button', { class: 'btn btn--outline', id: 'btn-clear-response', text: 'Clear Response' }),
        Utils.el('div', { class: 'spacer' }),
        Utils.el('button', { class: 'btn btn--outline', id: 'btn-previous', text: 'Previous' }),
        Utils.el('button', { class: 'btn btn--primary', id: 'btn-save-next', text: 'Save & Next' }),
      ]);

      const examMain = Utils.el('div', { class: 'exam-main' }, [sectionTabs, questionScroll, toolbar]);

      const candidateBox = Utils.el('div', { class: 'candidate-box' }, [
        Utils.el('div', { class: 'avatar', text: 'C' }),
        Utils.el('div', {}, [
          Utils.el('div', { text: 'Candidate' }),
          Utils.el('div', { style: 'color:var(--ink-400)', text: Utils.localizedText(cfg.examName, 'en') }),
        ]),
      ]);

      const legend = Utils.el('div', { class: 'legend' }, [
        this.legendItem('var(--st-not-visited)', 'Not Visited'),
        this.legendItem('var(--st-not-answered)', 'Not Answered'),
        this.legendItem('var(--st-answered)', 'Answered'),
        this.legendItem('var(--st-marked)', 'Marked for Review'),
        this.legendItem('var(--st-answered-marked)', 'Answered + Marked', true),
      ]);

      const paletteScroll = Utils.el('div', { class: 'palette-scroll', id: 'palette-scroll' });

      const sideActions = Utils.el('div', { class: 'side-actions' }, [
        Utils.el('button', { class: 'btn btn--danger btn--block', id: 'btn-submit-test', text: 'Submit Test' }),
      ]);

      const examSide = Utils.el('aside', { class: 'exam-side', id: 'exam-side' }, [candidateBox, legend, paletteScroll, sideActions]);

      root.appendChild(Utils.el('div', { class: 'exam-shell' }, [
        header,
        Utils.el('div', { class: 'exam-body' }, [examMain, examSide]),
      ]));

      this.buildHeaderTools(header);
      this.buildSidePanels(root);
      this.wireToolbar();

      Utils.qs('#btn-toggle-sidebar').addEventListener('click', () => Utils.qs('#exam-side').classList.toggle('is-open'));
    },

    legendItem(color, label, dual) {
      const dot = Utils.el('span', { class: 'legend__dot', style: `background:${color};${dual ? 'border-radius:50%;position:relative' : ''}` });
      return Utils.el('div', { class: 'legend__item' }, [dot, Utils.el('span', { text: label })]);
    },

    buildHeaderTools(header) {
      const tools = Utils.qs('#header-tools', header);
      const cfg = this.examConfig;

      if (cfg.features && cfg.features.languageSwitchEnabled && cfg.languages && cfg.languages.length > 1) {
        const wrap = Utils.el('div', { class: 'lang-toggle', id: 'lang-toggle' });
        cfg.languages.forEach((code) => {
          const btn = Utils.el('button', { text: code.toUpperCase(), 'data-lang': code });
          btn.addEventListener('click', () => this.setLanguage(code));
          wrap.appendChild(btn);
        });
        tools.appendChild(wrap);
      }

      if (cfg.features && cfg.features.fontSizeControlEnabled) {
        tools.appendChild(Utils.el('button', { class: 'icon-btn', 'aria-label': 'Decrease font size', text: 'A-', onClick: () => this.adjustFont(-1) }));
        tools.appendChild(Utils.el('button', { class: 'icon-btn', 'aria-label': 'Increase font size', text: 'A+', onClick: () => this.adjustFont(1) }));
      }

      tools.appendChild(Utils.el('button', {
        class: 'icon-btn', id: 'btn-theme', 'aria-label': 'Toggle dark mode', text: '\u25D1',
        onClick: () => this.toggleTheme(),
      }));

      if (cfg.features && cfg.features.calculatorEnabled) {
        tools.appendChild(Utils.el('button', { class: 'icon-btn', id: 'btn-calc', 'aria-label': 'Open calculator', text: '\uD83D\uDDA9', onClick: () => this.togglePanel('calculator') }));
      }
      if (cfg.features && cfg.features.notepadEnabled) {
        tools.appendChild(Utils.el('button', { class: 'icon-btn', id: 'btn-notepad', 'aria-label': 'Open notepad', text: '\uD83D\uDCDD', onClick: () => this.togglePanel('notepad') }));
      }
      if (cfg.features && cfg.features.fullscreenMode) {
        tools.appendChild(Utils.el('button', { class: 'icon-btn', 'aria-label': 'Toggle fullscreen', text: '\u26F6', onClick: () => this.toggleFullscreen() }));
      }
    },

    buildSidePanels(root) {
      root.appendChild(Utils.el('div', { class: 'panel-overlay', id: 'panel-overlay', onClick: () => this.closePanels() }));

      root.appendChild(Utils.el('div', { class: 'side-panel', id: 'panel-calculator' }, [
        Utils.el('div', { class: 'side-panel__head' }, [Utils.el('span', { text: 'Calculator' }), Utils.el('button', { class: 'btn--ghost btn', text: '\u2715', onClick: () => this.closePanels() })]),
        Utils.el('div', { class: 'side-panel__body', id: 'calc-body' }),
      ]));
      this.buildCalculator();

      root.appendChild(Utils.el('div', { class: 'side-panel', id: 'panel-notepad' }, [
        Utils.el('div', { class: 'side-panel__head' }, [Utils.el('span', { text: 'Notepad' }), Utils.el('button', { class: 'btn--ghost btn', text: '\u2715', onClick: () => this.closePanels() })]),
        Utils.el('div', { class: 'side-panel__body' }, [
          Utils.el('textarea', { class: 'notepad-textarea', id: 'notepad-textarea', placeholder: 'Jot down rough work here. It is saved automatically and restored if you refresh.' }),
          Utils.el('button', { class: 'btn btn--outline btn--sm', style: 'margin-top:10px', text: 'Clear Notes', onClick: () => { Utils.qs('#notepad-textarea').value = ''; this.session.state.notepad = ''; this.persist(); } }),
        ]),
      ]));
      const notepadArea = Utils.qs('#notepad-textarea');
      notepadArea.value = this.session.state.notepad || '';
      notepadArea.addEventListener('input', () => { this.session.state.notepad = notepadArea.value; this.persist(); });
    },

    togglePanel(which) {
      const target = which === 'calculator' ? '#panel-calculator' : '#panel-notepad';
      const other = which === 'calculator' ? '#panel-notepad' : '#panel-calculator';
      Utils.qs(other).classList.remove('is-open');
      Utils.qs(target).classList.toggle('is-open');
      const anyOpen = Utils.qs('#panel-calculator').classList.contains('is-open') || Utils.qs('#panel-notepad').classList.contains('is-open');
      Utils.qs('#panel-overlay').classList.toggle('is-open', anyOpen);
    },
    closePanels() {
      Utils.qs('#panel-calculator').classList.remove('is-open');
      Utils.qs('#panel-notepad').classList.remove('is-open');
      Utils.qs('#panel-overlay').classList.remove('is-open');
    },

    buildCalculator() {
      const body = Utils.qs('#calc-body');
      const display = Utils.el('div', { class: 'calc-display', id: 'calc-display', text: '0' });
      body.appendChild(display);

      const calcState = { current: '0', previous: null, operator: null, overwrite: true };
      const render = () => { display.textContent = calcState.current; };

      const inputDigit = (d) => {
        if (calcState.overwrite) { calcState.current = d === '.' ? '0.' : d; calcState.overwrite = false; }
        else if (d === '.' && calcState.current.includes('.')) { /* ignore extra dot */ }
        else calcState.current += d;
        render();
      };
      const chooseOp = (op) => {
        if (calcState.operator && !calcState.overwrite) compute();
        calcState.previous = parseFloat(calcState.current);
        calcState.operator = op;
        calcState.overwrite = true;
      };
      const compute = () => {
        if (calcState.operator === null || calcState.previous === null) return;
        const a = calcState.previous, b = parseFloat(calcState.current);
        let result = b;
        if (calcState.operator === '+') result = a + b;
        if (calcState.operator === '-') result = a - b;
        if (calcState.operator === '\u00D7') result = a * b;
        if (calcState.operator === '\u00F7') result = b === 0 ? 0 : a / b;
        calcState.current = String(Utils.round(result, 8));
        calcState.operator = null;
        calcState.previous = null;
        calcState.overwrite = true;
        render();
      };
      const clearAll = () => { calcState.current = '0'; calcState.previous = null; calcState.operator = null; calcState.overwrite = true; render(); };

      const grid = Utils.el('div', { class: 'calc-grid' });
      const buttons = [
        ['C', 'op'], ['\u00F7', 'op'], ['\u00D7', 'op'], ['-', 'op'],
        ['7', ''], ['8', ''], ['9', ''], ['+', 'op'],
        ['4', ''], ['5', ''], ['6', ''], ['=', 'eq'],
        ['1', ''], ['2', ''], ['3', ''],
        ['0', 'zero'], ['.', ''],
      ];
      buttons.forEach(([label, cls]) => {
        const btn = Utils.el('button', { class: cls, text: label });
        btn.addEventListener('click', () => {
          if (label === 'C') clearAll();
          else if (label === '=') compute();
          else if (['+', '-', '\u00D7', '\u00F7'].includes(label)) chooseOp(label);
          else inputDigit(label);
        });
        grid.appendChild(btn);
      });
      body.appendChild(grid);
    },

    setLanguage(code) {
      this.session.state.language = code;
      this.persist();
      Utils.qsa('#lang-toggle button').forEach((b) => b.classList.toggle('is-active', b.dataset.lang === code));
      this.renderQuestion();
    },

    adjustFont(dir) {
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--fs-base'), 10) || 16;
      const next = Math.min(20, Math.max(14, current + dir));
      Prefs.applyFontScale(next);
    },

    toggleTheme() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      Prefs.applyTheme(isDark ? 'light' : 'dark');
    },

    toggleFullscreen() {
      if (document.fullscreenElement || document.webkitFullscreenElement) this.exitFullscreenIfActive();
      else this.tryEnterFullscreen();
    },

    wireToolbar() {
      Utils.qs('#btn-mark-review').addEventListener('click', () => this.onMarkForReview());
      Utils.qs('#btn-clear-response').addEventListener('click', () => this.onClearResponse());
      Utils.qs('#btn-previous').addEventListener('click', () => this.onNavigate(-1));
      Utils.qs('#btn-save-next').addEventListener('click', () => this.onSaveNext());
      Utils.qs('#btn-submit-test').addEventListener('click', () => this.showSubmitModal());
    },

    /* ---- Rendering ---- */
    renderAll() {
      this.renderSectionTabs();
      this.renderQuestion();
      this.renderPalette();
      const langBtns = Utils.qsa('#lang-toggle button');
      langBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.lang === this.session.state.language));
    },

    currentQuestion() { return this.questions[this.session.state.currentIndex]; },
    lang() { return this.session.state.language; },

    renderSectionTabs() {
      const wrap = Utils.qs('#section-tabs');
      wrap.innerHTML = '';
      const cfg = this.examConfig;
      const switchingAllowed = !cfg.features || cfg.features.sectionSwitchingAllowed !== false;
      const currentSectionId = this.currentQuestion() ? this.currentQuestion().section : null;

      (cfg.sections || []).forEach((section) => {
        const firstIdx = this.questions.findIndex((q) => q.section === section.id);
        if (firstIdx === -1) return;
        const btn = Utils.el('button', { text: Utils.localizedText(section.name, this.lang()) });
        btn.classList.toggle('is-active', section.id === currentSectionId);
        if (!switchingAllowed && section.id !== currentSectionId) btn.disabled = true;
        btn.addEventListener('click', () => { this.goToIndex(firstIdx); });
        wrap.appendChild(btn);
      });
    },

    renderQuestion() {
      const q = this.currentQuestion();
      if (!q) return;
      this.session.visit(q.id);
      this.persist();

      const section = CBTScoring.findSection(this.examConfig, q.section);
      const marks = CBTScoring.resolveMarks(q, section, this.examConfig);
      const negMarks = CBTScoring.resolveNegativeMarks(q, section, this.examConfig, marks);
      const lang = this.lang();

      const scroll = Utils.qs('#question-scroll');
      scroll.innerHTML = '';

      scroll.appendChild(Utils.el('div', { class: 'question-meta-row' }, [
        Utils.el('span', { class: 'question-number-chip', text: `Q${this.session.state.currentIndex + 1} / ${this.questions.length}` }),
        Utils.el('span', { class: 'question-marks', html: `<b>+${marks}</b>${negMarks ? ` <span class="neg">-${negMarks}</span>` : ''}` }),
        Utils.el('span', { class: 'pill', text: Utils.localizedText(section ? section.name : q.section, lang) }),
        q.difficulty ? Utils.el('span', { class: 'pill', text: q.difficulty }) : null,
      ]));

      scroll.appendChild(Utils.el('p', { class: 'question-text', text: Utils.localizedText(q.questionText, lang) }));

      const optionsList = Utils.el('div', { class: 'options-list' });
      const selected = this.session.state.answers[q.id];
      (q.options || []).forEach((opt, i) => {
        const isSelected = selected === opt.id;
        const row = Utils.el('label', { class: `option-item${isSelected ? ' is-selected' : ''}` }, [
          Utils.el('input', { type: 'radio', name: `opt-${q.id}`, ...(isSelected ? { checked: 'checked' } : {}) }),
          Utils.el('span', { class: 'option-item__label' }, [
            Utils.el('span', { class: 'option-item__key', text: String.fromCharCode(65 + i) + '.' }),
            document.createTextNode(Utils.localizedText(opt.text, lang)),
          ]),
        ]);
        row.querySelector('input').addEventListener('change', () => {
          this.session.setAnswer(q.id, opt.id);
          this.persist();
          this.renderQuestion();
          this.renderPalette();
        });
        optionsList.appendChild(row);
      });
      scroll.appendChild(optionsList);

      Utils.qs('#btn-previous').disabled = this.session.state.currentIndex === 0;
      const isMarked = !!this.session.state.marked[q.id];
      Utils.qs('#btn-mark-review').textContent = isMarked ? 'Unmark Review' : 'Mark for Review';
    },

    renderPalette() {
      const wrap = Utils.qs('#palette-scroll');
      wrap.innerHTML = '';
      const cfg = this.examConfig;
      (cfg.sections || []).forEach((section) => {
        const sectionQuestions = [];
        this.questions.forEach((q, idx) => { if (q.section === section.id) sectionQuestions.push({ q, idx }); });
        if (!sectionQuestions.length) return;

        wrap.appendChild(Utils.el('div', { class: 'palette-section-title', text: Utils.localizedText(section.name, this.lang()) }));
        const grid = Utils.el('div', { class: 'palette-grid' });
        sectionQuestions.forEach(({ q, idx }) => {
          const status = this.session.statusFor(q.id);
          const btn = Utils.el('button', {
            class: `palette-btn st-${status}${idx === this.session.state.currentIndex ? ' is-current' : ''}`,
            text: String(idx + 1),
            'aria-label': `Question ${idx + 1}, ${status.replace('-', ' ')}`,
          });
          btn.addEventListener('click', () => this.goToIndex(idx));
          grid.appendChild(btn);
        });
        wrap.appendChild(grid);
      });
    },

    goToIndex(idx) {
      if (idx < 0 || idx >= this.questions.length) return;
      this.session.state.currentIndex = idx;
      this.persist();
      this.renderSectionTabs();
      this.renderQuestion();
      this.renderPalette();
    },

    onNavigate(delta) { this.goToIndex(this.session.state.currentIndex + delta); },

    onSaveNext() {
      const q = this.currentQuestion();
      this.session.visit(q.id);
      this.persist();
      this.renderPalette();
      if (this.session.state.currentIndex < this.questions.length - 1) this.onNavigate(1);
      else Utils.toast('This is the last question. Review the palette or submit when ready.');
    },

    onClearResponse() {
      const q = this.currentQuestion();
      this.session.clearAnswer(q.id);
      this.persist();
      this.renderQuestion();
      this.renderPalette();
    },

    onMarkForReview() {
      const q = this.currentQuestion();
      this.session.toggleMark(q.id);
      this.persist();
      this.renderQuestion();
      this.renderPalette();
    },

    showSubmitModal() {
      const overlay = Utils.qs('#modal-submit');
      overlay.hidden = false;
      const c = this.session.counts(this.questions.map((q) => q.id));
      Utils.qs('#submit-answered', overlay).textContent = c.answered;
      Utils.qs('#submit-not-answered', overlay).textContent = c.notAnswered;
      Utils.qs('#submit-marked', overlay).textContent = c.marked;
      Utils.qs('#submit-not-visited', overlay).textContent = c.notVisited;
      Utils.qs('#btn-confirm-submit', overlay).onclick = () => { overlay.hidden = true; this.submitTest(false); };
      Utils.qs('#btn-cancel-submit', overlay).onclick = () => { overlay.hidden = true; };
    },

    submitTest(auto) {
      if (this.timer) this.timer.stop();
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.exitFullscreenIfActive();

      const result = CBTScoring.scoreAttempt(this.examConfig, this.questions, this.session.state.answers, this.session.state.marked);
      const attemptId = `${this.entry.testId}-${Date.now()}`;
      const durationSec = (this.examConfig.durationMinutes || 0) * 60;
      const remainingSec = Math.max(0, Math.round((this.session.state.endTimestamp - Date.now()) / 1000));
      const timeTakenSec = auto ? durationSec : Math.max(0, durationSec - remainingSec);

      const payload = {
        attemptId,
        testId: this.entry.testId,
        examName: Utils.localizedText(this.examConfig.examName, 'en'),
        organization: this.examConfig.organization,
        language: this.session.state.language,
        resultSettings: this.examConfig.resultSettings || {},
        startedAt: this.session.state.startedAt,
        submittedAt: Date.now(),
        timeTakenSeconds: timeTakenSec,
        durationSeconds: durationSec,
        autoSubmitted: !!auto,
        ...result,
      };

      CBTStorage.saveResult(attemptId, payload);
      CBTStorage.clearSession(this.entry.testId);
      window.location.href = `result.html?resultId=${encodeURIComponent(attemptId)}`;
    },
  };
  TestController.beforeUnloadHandler = TestController.beforeUnloadHandler.bind(TestController);

  /* ===========================================================================
   * ResultController — drives result.html
   * =========================================================================== */
  const ResultController = {
    result: null,
    activeFilter: 'all',
    lang: 'en',

    init() {
      Prefs.initTheme();
      Prefs.initFontScale();
      const resultId = Utils.getParam('resultId');
      const root = Utils.qs('#result-root');
      const result = resultId && CBTStorage.getResult(resultId);
      if (!result) {
        root.innerHTML = '';
        root.appendChild(Utils.el('div', { class: 'error-state' }, [
          Utils.el('p', { text: 'We could not find that result. It may have been cleared from this browser.' }),
          Utils.el('a', { class: 'btn btn--primary', href: 'index.html', text: 'Back to test list' }),
        ]));
        return;
      }
      this.result = result;
      this.lang = result.language || 'en';
      document.title = `${result.examName} — Result — RajDailyTools`;
      this.render();
    },

    render() {
      const r = this.result;
      const settings = r.resultSettings || {};
      const root = Utils.qs('#result-root');
      root.innerHTML = '';

      root.appendChild(this.renderHero());

      const wrap = Utils.el('div', { class: 'page-wrap' });
      if (settings.showSectionWise !== false) wrap.appendChild(this.renderSectionWise());
      if (settings.showTopicWise !== false) wrap.appendChild(this.renderTopicWise());
      if (settings.showQuestionReview !== false) wrap.appendChild(this.renderReview());

      wrap.appendChild(Utils.el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:8px' }, [
        Utils.el('a', { class: 'btn btn--outline', href: 'index.html', text: 'Back to Tests' }),
        Utils.el('a', { class: 'btn btn--primary', href: `test.html?test=${encodeURIComponent(r.testId)}`, text: 'Retake This Test' }),
      ]));

      root.appendChild(wrap);
    },

    renderHero() {
      const r = this.result;
      const header = Utils.el('div', { class: 'result-header' }, [
        Utils.el('div', { class: 'result-header__inner' }, [
          Utils.el('h1', { text: r.examName }),
          Utils.el('p', { text: `${r.organization || ''} • Submitted ${new Date(r.submittedAt).toLocaleString()}${r.autoSubmitted ? ' • Auto-submitted on timeout' : ''}` }),
          Utils.el('div', { class: 'score-hero' }, [
            Utils.el('div', { class: 'score-card hero-score' }, [
              Utils.el('div', { class: 'num', text: `${r.scoreObtained} / ${r.maxMarks}` }),
              Utils.el('div', { class: 'lbl', text: 'Score' }),
            ]),
            this.scoreCard(r.correct, 'Correct'),
            this.scoreCard(r.wrong, 'Wrong'),
            this.scoreCard(r.unattempted, 'Unattempted'),
            this.scoreCard(r.accuracyPercent + '%', 'Accuracy'),
            this.scoreCard(Utils.formatDuration(r.timeTakenSeconds), 'Time Taken'),
          ]),
        ]),
      ]);
      return header;
    },
    scoreCard(num, lbl) {
      return Utils.el('div', { class: 'score-card' }, [Utils.el('div', { class: 'num', text: String(num) }), Utils.el('div', { class: 'lbl', text: lbl })]);
    },

    renderSectionWise() {
      const r = this.result;
      const table = Utils.el('table', { class: 'data-table' }, [
        Utils.el('thead', {}, [Utils.el('tr', {}, [
          Utils.el('th', { text: 'Section' }), Utils.el('th', { class: 'num', text: 'Total' }), Utils.el('th', { class: 'num', text: 'Attempted' }),
          Utils.el('th', { class: 'num', text: 'Correct' }), Utils.el('th', { class: 'num', text: 'Wrong' }), Utils.el('th', { class: 'num', text: 'Score' }),
        ])]),
        Utils.el('tbody', {}, r.sectionWise.map((s) => Utils.el('tr', {}, [
          Utils.el('td', { text: s.name }), Utils.el('td', { class: 'num', text: s.total }), Utils.el('td', { class: 'num', text: s.attempted }),
          Utils.el('td', { class: 'num', text: s.correct }), Utils.el('td', { class: 'num', text: s.wrong }),
          Utils.el('td', { class: 'num', text: `${s.scoreObtained}/${s.maxMarks}` }),
        ]))),
      ]);
      return Utils.el('div', { class: 'result-section' }, [Utils.el('h2', { text: 'Section-wise Performance' }), table]);
    },

    renderTopicWise() {
      const r = this.result;
      const table = Utils.el('table', { class: 'data-table' }, [
        Utils.el('thead', {}, [Utils.el('tr', {}, [
          Utils.el('th', { text: 'Topic' }), Utils.el('th', { class: 'num', text: 'Total' }),
          Utils.el('th', { class: 'num', text: 'Correct' }), Utils.el('th', { class: 'num', text: 'Wrong' }), Utils.el('th', { class: 'num', text: 'Score' }),
        ])]),
        Utils.el('tbody', {}, r.topicWise.map((t) => Utils.el('tr', {}, [
          Utils.el('td', { text: t.topic }), Utils.el('td', { class: 'num', text: t.total }),
          Utils.el('td', { class: 'num', text: t.correct }), Utils.el('td', { class: 'num', text: t.wrong }),
          Utils.el('td', { class: 'num', text: `${t.scoreObtained}/${t.maxMarks}` }),
        ]))),
      ]);
      return Utils.el('div', { class: 'result-section' }, [Utils.el('h2', { text: 'Topic-wise Performance' }), table]);
    },

    renderReview() {
      const r = this.result;
      const section = Utils.el('div', { class: 'result-section' });
      section.appendChild(Utils.el('h2', { text: 'Question-wise Review' }));

      const filters = ['all', 'correct', 'wrong', 'unattempted', 'marked'];
      const filterRow = Utils.el('div', { class: 'filter-row' });
      filters.forEach((f) => {
        const btn = Utils.el('button', { text: f[0].toUpperCase() + f.slice(1) });
        btn.classList.toggle('is-active', f === this.activeFilter);
        btn.addEventListener('click', () => { this.activeFilter = f; this.refreshReviewList(list); Utils.qsa('button', filterRow).forEach((b) => b.classList.toggle('is-active', b === btn)); });
        filterRow.appendChild(btn);
      });
      section.appendChild(filterRow);

      const list = Utils.el('div', { id: 'review-list' });
      section.appendChild(list);
      this.refreshReviewList(list);
      return section;
    },

    refreshReviewList(list) {
      const r = this.result;
      list.innerHTML = '';
      const items = r.perQuestion.filter((pq) => {
        if (this.activeFilter === 'all') return true;
        if (this.activeFilter === 'marked') return pq.isMarked;
        return pq.status === this.activeFilter;
      });
      if (!items.length) {
        list.appendChild(Utils.el('div', { class: 'empty-state', text: 'No questions match this filter.' }));
        return;
      }
      items.forEach((pq, i) => list.appendChild(this.renderReviewCard(pq, i)));
    },

    renderReviewCard(pq, i) {
      const q = pq.question;
      const lang = this.lang;
      const statusLabel = pq.status === 'unattempted' ? 'skipped' : pq.status;
      const card = Utils.el('div', { class: 'review-card' });
      card.appendChild(Utils.el('div', { class: 'review-card__head' }, [
        Utils.el('span', { class: 'question-number-chip', text: `Q${i + 1}` }),
        Utils.el('span', { class: `status-chip ${statusLabel}`, text: statusLabel }),
        Utils.el('span', { class: 'pill', text: pq.sectionName }),
        pq.topic ? Utils.el('span', { class: 'pill', text: pq.topic }) : null,
        pq.isMarked ? Utils.el('span', { class: 'pill', text: 'Was marked for review' }) : null,
        Utils.el('span', { style: 'margin-left:auto;font-size:12.5px;color:var(--ink-400)', text: `Marks: ${pq.marksAwarded >= 0 ? '+' : ''}${pq.marksAwarded}` }),
      ]));
      card.appendChild(Utils.el('p', { class: 'question-text', style: 'font-size:15px;margin-bottom:12px', text: Utils.localizedText(q.questionText, lang) }));

      (q.options || []).forEach((opt) => {
        const isCorrect = opt.id === pq.correctOptionId;
        const isChosenWrong = opt.id === pq.chosenOptionId && !isCorrect;
        let cls = 'review-option';
        if (isCorrect) cls += ' correct-answer';
        else if (isChosenWrong) cls += ' wrong-answer';
        const suffix = isCorrect ? '  ✓ Correct answer' : (isChosenWrong ? '  ✗ Your answer' : '');
        card.appendChild(Utils.el('div', { class: cls, text: Utils.localizedText(opt.text, lang) + suffix }));
      });

      if (pq.status === 'unattempted') {
        card.appendChild(Utils.el('div', { class: 'pill', style: 'margin-top:6px', text: 'You did not attempt this question' }));
      }

      if (this.result.resultSettings && this.result.resultSettings.showExplanations !== false && q.explanation) {
        card.appendChild(Utils.el('div', { class: 'explanation-box', text: Utils.localizedText(q.explanation, lang) }));
      }
      return card;
    },
  };

  /* ===========================================================================
   * Bootstrap — pick the controller based on <body data-page="...">
   * =========================================================================== */
  document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;
    if (page === 'home') HomeController.init();
    else if (page === 'test') TestController.init();
    else if (page === 'result') ResultController.init();
  });
})();
