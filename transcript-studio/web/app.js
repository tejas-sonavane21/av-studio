/**
 * web/app.js — the page behind `npm start`.
 *
 * It is a thin client on purpose: the browser driver, the queue and the artifact
 * writers all live on the server, so this file is file selection, one POST and a
 * poll. The progress it shows is the server's own phase, never a made-up timer.
 */

const $ = (selector) => document.querySelector(selector);

const state = {
  file: null,
  jobId: null,
  pollTimer: null,
};

const emitKinds = () => {
  const checked = [...document.querySelectorAll('input[name="emit"]:checked')].map((input) => input.value);
  return ['json', 'srt', 'vtt', ...checked].join(',');
};

function showError(message, hint = '') {
  const box = $('#error');
  box.hidden = false;
  box.textContent = hint ? `${message} — ${hint}` : message;
}

function clearError() {
  const box = $('#error');
  box.hidden = true;
  box.textContent = '';
}

function setFile(file) {
  state.file = file || null;
  const drop = $('#drop');
  const title = $('#drop-title');
  const hint = $('#drop-hint');
  drop.classList.toggle('filled', Boolean(file));
  if (!file) {
    title.textContent = 'Drop an audio file, or click to choose one';
    hint.textContent = 'MP3, WAV or FLAC · 1 s to 5 min · at most 25 MB';
  } else {
    title.textContent = file.name;
    hint.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
  }
  $('#run').disabled = !file || Boolean(state.jobId);
  clearError();
}

async function loadHealth() {
  const badge = $('#engine-badge');
  try {
    const response = await fetch('/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    badge.textContent = `${health.provider} · ${health.queue.running ? 'busy' : 'ready'}`;
    badge.classList.add('ok');
    const select = $('#language');
    select.innerHTML = '';
    for (const language of health.languages) {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = language.label;
      select.append(option);
    }
    select.value = 'auto';
    $('#drop-hint').textContent = `MP3, WAV or FLAC · 1 s to ${health.limits.maxSeconds / 60} min · at most ${Math.round(
      health.limits.maxBytes / (1024 * 1024),
    )} MB`;
  } catch (error) {
    badge.textContent = 'server unavailable';
    showError('could not reach the local server', error.message);
  }
}

function renderProgress(job) {
  $('#progress-card').hidden = false;
  $('#progress-phase').textContent = job.phase;
  $('#progress-detail').textContent = job.detail || '';
  $('#bar-fill').style.width = `${Math.round(job.progress * 100)}%`;
}

function renderResult(job) {
  $('#progress-card').hidden = true;
  $('#result-card').hidden = false;
  $('#result-title').textContent = job.summary ? 'Transcription complete' : 'Done';
  $('#result-summary').textContent = job.summary
    ? `${job.summary.chunks} chunks · ${job.summary.words} words · ${job.summary.duration.toFixed(2)} s of audio`
    : '';

  const list = $('#files');
  list.innerHTML = '';
  for (const file of job.files) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = file.url;
    link.download = file.filename;
    link.textContent = file.filename;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = file.label;
    item.append(link, kind);
    list.append(item);
  }

  const warnings = $('#warnings');
  const entries = job.summary?.warnings ?? [];
  warnings.hidden = entries.length === 0;
  warnings.innerHTML = '';
  if (entries.length) {
    const title = document.createElement('strong');
    title.textContent = 'Notes from this run';
    const ul = document.createElement('ul');
    for (const warning of entries) {
      const li = document.createElement('li');
      li.textContent = warning;
      ul.append(li);
    }
    warnings.append(title, ul);
  }
}

async function poll(jobId) {
  const response = await fetch(`/jobs/${jobId}`);
  if (!response.ok) throw new Error(`the server lost job ${jobId}`);
  const job = await response.json();
  renderProgress(job);
  if (job.status === 'done') {
    state.jobId = null;
    $('#run').disabled = false;
    renderResult(job);
    return;
  }
  if (job.status === 'error') {
    state.jobId = null;
    $('#run').disabled = false;
    $('#progress-card').hidden = true;
    showError(job.error || 'the job failed', job.hint || '');
    return;
  }
  state.pollTimer = setTimeout(() => {
    poll(jobId).catch((error) => {
      state.jobId = null;
      $('#run').disabled = false;
      showError('could not follow the job', error.message);
    });
  }, 700);
}

async function submit(event) {
  event.preventDefault();
  if (!state.file || state.jobId) return;
  clearError();
  $('#result-card').hidden = true;
  const params = new URLSearchParams({
    name: state.file.name,
    language: $('#language').value,
    emit: emitKinds(),
  });
  $('#run').disabled = true;
  $('#progress-card').hidden = false;
  renderProgress({ phase: 'uploading', detail: 'sending the file to the local server', progress: 0.02 });
  try {
    const response = await fetch(`/transcribe?${params}`, { method: 'POST', body: state.file });
    const body = await response.json();
    if (!response.ok) throw new Error(body.hint ? `${body.error} — ${body.hint}` : body.error || `HTTP ${response.status}`);
    state.jobId = body.jobId;
    poll(body.jobId).catch((error) => showError('could not follow the job', error.message));
  } catch (error) {
    $('#run').disabled = false;
    $('#progress-card').hidden = true;
    showError(error.message);
  }
}

$('#drop').addEventListener('click', () => $('#audio-input').click());
$('#audio-input').addEventListener('change', (event) => setFile(event.target.files?.[0] ?? null));

for (const type of ['dragenter', 'dragover']) {
  $('#drop').addEventListener(type, (event) => {
    event.preventDefault();
    $('#drop').classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  $('#drop').addEventListener(type, (event) => {
    event.preventDefault();
    $('#drop').classList.remove('dragging');
  });
}
$('#drop').addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) setFile(file);
});

$('#job-form').addEventListener('submit', submit);
$('#reset').addEventListener('click', () => {
  clearTimeout(state.pollTimer);
  state.jobId = null;
  $('#result-card').hidden = true;
  $('#progress-card').hidden = true;
  $('#audio-input').value = '';
  setFile(null);
});

loadHealth();
