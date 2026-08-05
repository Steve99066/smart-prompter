(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    editorScreen: $("editorScreen"),
    sessionScreen: $("sessionScreen"),
    scriptInput: $("scriptInput"),
    chunkSize: $("chunkSize"),
    modeSelect: $("modeSelect"),
    threshold: $("threshold"),
    thresholdValue: $("thresholdValue"),
    speechRate: $("speechRate"),
    rateValue: $("rateValue"),
    voiceSelect: $("voiceSelect"),
    nextDelay: $("nextDelay"),
    delayValue: $("delayValue"),
    prepareBtn: $("prepareBtn"),
    clearBtn: $("clearBtn"),
    segmentsCard: $("segmentsCard"),
    segmentsList: $("segmentsList"),
    segmentsCount: $("segmentsCount"),
    startBtn: $("startBtn"),
    addSegmentBtn: $("addSegmentBtn"),
    segmentTemplate: $("segmentTemplate"),
    backToEditBtn: $("backToEditBtn"),
    previousSegment: $("previousSegment"),
    currentSegment: $("currentSegment"),
    nextSegment: $("nextSegment"),
    recognizedText: $("recognizedText"),
    statusPill: $("statusPill"),
    progressText: $("progressText"),
    progressFill: $("progressFill"),
    matchText: $("matchText"),
    prevBtn: $("prevBtn"),
    repeatBtn: $("repeatBtn"),
    pauseBtn: $("pauseBtn"),
    nextBtn: $("nextBtn"),
    supportWarning: $("supportWarning"),
    installBtn: $("installBtn")
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognitionActive = false;
  let retryListening = false;
  let voices = [];
  let segments = [];
  let currentIndex = 0;
  let running = false;
  let speaking = false;
  let paused = true;
  let restartTimer = null;
  let nextTimer = null;
  let wakeLock = null;
  let deferredInstallPrompt = null;

  const STORAGE_KEY = "smartPrompterV01";

  function normalizeArabic(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
      .replace(/[إأآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ـ/g, "")
      .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function words(text) {
    return normalizeArabic(text).split(" ").filter(Boolean);
  }

  function lcsLength(a, b) {
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  function similarity(expected, heard) {
    const a = words(expected);
    const b = words(heard);
    if (!a.length || !b.length) return 0;
    const lcs = lcsLength(a, b);
    const coverage = lcs / a.length;
    const precision = lcs / b.length;
    return Math.round((coverage * 0.75 + precision * 0.25) * 100);
  }

  function splitScript(text, size) {
    const ranges = {
      short: [4, 7],
      medium: [8, 13],
      long: [14, 20]
    };
    const [minWords, maxWords] = ranges[size] || ranges.medium;
    const cleaned = text.replace(/\r/g, "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return [];

    const sentences = cleaned
      .split(/(?<=[.!؟?؛;،,:\n])\s+/)
      .map(s => s.trim())
      .filter(Boolean);

    const result = [];
    for (const sentence of sentences.length ? sentences : [cleaned]) {
      const sentenceWords = sentence.split(/\s+/).filter(Boolean);
      if (sentenceWords.length <= maxWords) {
        result.push(sentence);
        continue;
      }

      let buffer = [];
      for (const word of sentenceWords) {
        buffer.push(word);
        const endsSoftly = /[،,:؛;]$/.test(word);
        if (buffer.length >= maxWords || (buffer.length >= minWords && endsSoftly)) {
          result.push(buffer.join(" "));
          buffer = [];
        }
      }
      if (buffer.length) {
        if (buffer.length < minWords && result.length) {
          result[result.length - 1] += " " + buffer.join(" ");
        } else {
          result.push(buffer.join(" "));
        }
      }
    }
    return result.map(x => x.trim()).filter(Boolean);
  }

  function saveState() {
    const state = {
      script: els.scriptInput.value,
      chunkSize: els.chunkSize.value,
      mode: els.modeSelect.value,
      threshold: els.threshold.value,
      rate: els.speechRate.value,
      delay: els.nextDelay.value,
      voice: els.voiceSelect.value,
      segments
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadState() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (state.script) els.scriptInput.value = state.script;
      if (state.chunkSize) els.chunkSize.value = state.chunkSize;
      if (state.mode) els.modeSelect.value = state.mode;
      if (state.threshold) els.threshold.value = state.threshold;
      if (state.rate) els.speechRate.value = state.rate;
      if (state.delay) els.nextDelay.value = state.delay;
      if (Array.isArray(state.segments) && state.segments.length) {
        segments = state.segments;
        renderSegments();
      }
      updateLabels();
      setTimeout(() => {
        if (state.voice && [...els.voiceSelect.options].some(o => o.value === state.voice)) {
          els.voiceSelect.value = state.voice;
        }
      }, 500);
    } catch (error) {
      console.warn("Could not restore state", error);
    }
  }

  function updateLabels() {
    els.thresholdValue.textContent = `${els.threshold.value}%`;
    els.rateValue.textContent = `${Number(els.speechRate.value).toFixed(1)}×`;
    els.delayValue.textContent = `${Number(els.nextDelay.value).toFixed(1)} ثانية`;
  }

  function renderSegments() {
    els.segmentsList.innerHTML = "";
    segments.forEach((segment, index) => {
      const node = els.segmentTemplate.content.cloneNode(true);
      const item = node.querySelector(".segment-item");
      const number = node.querySelector(".segment-number");
      const textarea = node.querySelector(".segment-text");
      const deleteBtn = node.querySelector(".delete-segment");

      number.textContent = index + 1;
      textarea.value = segment;
      textarea.addEventListener("input", () => {
        segments[index] = textarea.value;
        saveState();
      });
      deleteBtn.addEventListener("click", () => {
        segments.splice(index, 1);
        renderSegments();
        saveState();
      });

      item.dataset.index = index;
      els.segmentsList.appendChild(node);
    });

    els.segmentsCount.textContent = `${segments.length} مقطع`;
    els.segmentsCard.classList.toggle("hidden", segments.length === 0);
  }

  function setStatus(text, type = "idle") {
    els.statusPill.textContent = text;
    els.statusPill.className = `status ${type}`;
  }

  function prepareScript() {
    segments = splitScript(els.scriptInput.value, els.chunkSize.value);
    if (!segments.length) {
      alert("ألصق سكريبت أولًا.");
      return;
    }
    renderSegments();
    saveState();
    els.segmentsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function collectSegmentsFromEditor() {
    segments = [...document.querySelectorAll(".segment-text")]
      .map(el => el.value.trim())
      .filter(Boolean);
  }

  function updateSessionView() {
    const total = segments.length;
    if (!total) return;

    currentIndex = Math.min(Math.max(currentIndex, 0), total - 1);
    els.previousSegment.textContent = currentIndex > 0 ? segments[currentIndex - 1] : "—";
    els.currentSegment.textContent = segments[currentIndex] || "—";
    els.nextSegment.textContent = currentIndex < total - 1 ? segments[currentIndex + 1] : "نهاية السكريبت";
    els.progressText.textContent = `${currentIndex + 1} / ${total}`;
    els.progressFill.style.width = `${((currentIndex + 1) / total) * 100}%`;
    els.recognizedText.textContent = "—";
    els.matchText.textContent = "المطابقة: —";
  }

  function showSession() {
    collectSegmentsFromEditor();
    if (!segments.length) {
      alert("لا يوجد أي مقطع.");
      return;
    }
    saveState();
    currentIndex = 0;
    running = false;
    paused = true;
    stopEverything();
    updateSessionView();
    els.editorScreen.classList.remove("active");
    els.sessionScreen.classList.add("active");
    els.pauseBtn.textContent = "ابدأ";
    setStatus("جاهز", "idle");
    requestWakeLock();
  }

  function showEditor() {
    stopEverything();
    running = false;
    paused = true;
    els.sessionScreen.classList.remove("active");
    els.editorScreen.classList.add("active");
    renderSegments();
    releaseWakeLock();
  }

  function loadVoices() {
    voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const current = els.voiceSelect.value;
    const arabicVoices = voices.filter(v => /^ar(-|_)/i.test(v.lang) || /arab/i.test(v.name));
    const list = arabicVoices.length ? arabicVoices : voices;
    els.voiceSelect.innerHTML = '<option value="">الصوت الافتراضي</option>';
    list.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} — ${voice.lang}`;
      els.voiceSelect.appendChild(option);
    });
    if ([...els.voiceSelect.options].some(o => o.value === current)) {
      els.voiceSelect.value = current;
    }
  }

  function selectedVoice() {
    return voices.find(v => v.voiceURI === els.voiceSelect.value) || null;
  }

  function speakCurrent() {
    if (!segments[currentIndex] || paused) return;
    clearTimeout(restartTimer);
    stopRecognition();
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(segments[currentIndex]);
    utterance.lang = "ar";
    utterance.rate = Number(els.speechRate.value);
    const voice = selectedVoice();
    if (voice) utterance.voice = voice;

    utterance.onstart = () => {
      speaking = true;
      setStatus("الملقّن يتحدث", "speaking");
    };
    utterance.onend = () => {
      speaking = false;
      if (!running || paused) return;
      const mode = els.modeSelect.value;
      if (mode === "manual") {
        setStatus("بانتظار التحكم اليدوي", "idle");
      } else {
        startRecognition();
      }
    };
    utterance.onerror = () => {
      speaking = false;
      setStatus("تعذر تشغيل الصوت", "paused");
    };

    speechSynthesis.speak(utterance);
  }

  function commandFrom(text) {
    const n = normalizeArabic(text);

    const repeatPatterns = ["اعاده", "إعادة", "اعد الجمله", "اعيد الجمله"];
    const previousPatterns = ["رجوع", "ارجع للجمله", "الجمله السابقه"];
    const continuePatterns = ["اكمل", "أكمل", "كمل"];

    if (repeatPatterns.some(p => n === normalizeArabic(p))) return "repeat";
    if (previousPatterns.some(p => n === normalizeArabic(p))) return "previous";
    if (continuePatterns.some(p => n === normalizeArabic(p))) return "continue";

    return null;
  }

  function handleCommand(command) {
    switch (command) {
      case "repeat":
        repeatCurrent();
        break;
      case "previous":
        goPrevious();
        break;
      case "continue":
        if (paused) resumeSession();
        else goNext(false);
        break;
    }
  }

  function setupRecognition() {
    if (!SpeechRecognition) {
      els.supportWarning.textContent =
        "المتصفح الحالي لا يدعم التعرف الصوتي المطلوب. جرّب Chrome على Android أو الكمبيوتر، أو استخدم الوضع اليدوي.";
      els.supportWarning.classList.remove("hidden");
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = "ar-SA";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onstart = () => {
      recognitionActive = true;
      retryListening = false;
      if (!running || paused || speaking) return;
      setStatus("أسمعك الآن", "listening");
    };

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text + " ";
        else interim += text + " ";
      }

      const heard = (finalText || interim).trim();
      if (!heard) return;

      els.recognizedText.textContent = heard;

      const command = commandFrom(heard);
      if (command && finalText) {
        retryListening = false;
        handleCommand(command);
        return;
      }

      const score = similarity(segments[currentIndex], heard);
      els.matchText.textContent = `المطابقة: ${score}%`;

      if (finalText) {
        const threshold = Number(els.threshold.value);

        if (score >= threshold) {
          retryListening = false;
          setStatus("تمت المطابقة", "comparing");
          clearTimeout(nextTimer);
          nextTimer = setTimeout(() => {
            if (running && !paused) goNext(true);
          }, Number(els.nextDelay.value) * 1000);
        } else {
          retryListening = true;
          setStatus("لم تتطابق — جرّب مرة ثانية", "listening");
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            if (recognitionActive) {
              try { recognition.stop(); } catch (_) {}
            } else {
              startRecognition();
            }
          }, 250);
        }
      }
    };

    recognition.onerror = (event) => {
      recognitionActive = false;

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        els.supportWarning.textContent =
          "لم يتم السماح باستخدام الميكروفون. افتح إعدادات الموقع في المتصفح واسمح للميكروفون، ثم أعد تحميل الصفحة.";
        els.supportWarning.classList.remove("hidden");
        pauseSession();
        return;
      }

      if (event.error === "no-speech") {
        retryListening = true;
        setStatus("ما سمعت كلامًا — ما زلت أستمع", "listening");
        return;
      }

      if (event.error !== "aborted") {
        retryListening = true;
        setStatus("تعذر فهم الصوت — سأحاول مجددًا", "listening");
      }
    };

    recognition.onend = () => {
      recognitionActive = false;

      if (running && !paused && !speaking && els.modeSelect.value !== "manual") {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          startRecognition();
        }, retryListening ? 180 : 350);
      }
    };
  }

  function startRecognition() {
    if (!recognition || recognitionActive || paused || speaking || !running || els.modeSelect.value === "manual") return;

    try {
      recognition.start();
    } catch (_) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startRecognition, 300);
    }
  }

  function stopRecognition() {
    if (!recognition) return;
    retryListening = false;
    try { recognition.abort(); } catch (_) {}
    recognitionActive = false;
  }

  function stopEverything() {
    clearTimeout(restartTimer);
    clearTimeout(nextTimer);
    stopRecognition();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    speaking = false;
  }

  function resumeSession() {
    running = true;
    paused = false;
    els.pauseBtn.textContent = "إيقاف مؤقت";
    speakCurrent();
  }

  function pauseSession() {
    paused = true;
    running = false;
    stopEverything();
    els.pauseBtn.textContent = "متابعة";
    setStatus("متوقف مؤقتًا", "paused");
  }

  function toggleSession() {
    if (paused) resumeSession();
    else pauseSession();
  }

  function goNext(fromMatch = false) {
    clearTimeout(nextTimer);
    stopEverything();
    if (currentIndex >= segments.length - 1) {
      running = false;
      paused = true;
      els.pauseBtn.textContent = "إعادة من البداية";
      setStatus("اكتمل السكريبت", "idle");
      return;
    }
    currentIndex++;
    updateSessionView();
    if (!paused || fromMatch) {
      running = true;
      paused = false;
      speakCurrent();
    }
  }

  function goPrevious() {
    stopEverything();
    currentIndex = Math.max(0, currentIndex - 1);
    updateSessionView();
    if (!paused) speakCurrent();
  }

  function repeatCurrent() {
    stopEverything();
    els.recognizedText.textContent = "—";
    els.matchText.textContent = "المطابقة: —";
    if (!paused) speakCurrent();
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch (_) {}
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    try { await wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("./service-worker.js").catch(console.warn);
    }
  }

  els.prepareBtn.addEventListener("click", prepareScript);
  els.clearBtn.addEventListener("click", () => {
    if (!confirm("هل تريد مسح السكريبت والمقاطع؟")) return;
    els.scriptInput.value = "";
    segments = [];
    renderSegments();
    saveState();
  });
  els.startBtn.addEventListener("click", showSession);
  els.addSegmentBtn.addEventListener("click", () => {
    segments.push("");
    renderSegments();
    saveState();
    const last = els.segmentsList.lastElementChild;
    if (last) last.querySelector("textarea").focus();
  });
  els.backToEditBtn.addEventListener("click", showEditor);
  els.pauseBtn.addEventListener("click", toggleSession);
  els.nextBtn.addEventListener("click", () => goNext(false));
  els.prevBtn.addEventListener("click", goPrevious);
  els.repeatBtn.addEventListener("click", repeatCurrent);

  [els.threshold, els.speechRate, els.nextDelay].forEach(el => {
    el.addEventListener("input", () => {
      updateLabels();
      saveState();
    });
  });
  [els.chunkSize, els.modeSelect, els.voiceSelect].forEach(el => {
    el.addEventListener("change", saveState);
  });

  document.addEventListener("keydown", (event) => {
    if (!els.sessionScreen.classList.contains("active")) return;
    if (event.code === "Space") {
      event.preventDefault();
      goNext(false);
    } else if (event.key.toLowerCase() === "r") {
      repeatCurrent();
    } else if (event.key === "ArrowRight") {
      goPrevious();
    } else if (event.key === "ArrowLeft") {
      goNext(false);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && els.sessionScreen.classList.contains("active")) {
      requestWakeLock();
    }
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installBtn.classList.remove("hidden");
  });

  els.installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBtn.classList.add("hidden");
  });

  if ("speechSynthesis" in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  } else {
    els.supportWarning.textContent = "المتصفح لا يدعم نطق النص. جرّب Chrome حديثًا.";
    els.supportWarning.classList.remove("hidden");
  }

  setupRecognition();
  loadState();
  updateLabels();
  registerServiceWorker();
})();
