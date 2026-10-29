// 侧栏列出真实会话；点击后由主进程挂载该会话的原生 Chromium 视图。
const list = document.getElementById('sessions');
const address = document.getElementById('address');
const status = document.getElementById('status');
const info = document.getElementById('info');
let active = null;

function renderState(state) {
  if (!state) return;
  if (state.conversationId !== active) return;
  if (document.activeElement !== address && state.url) address.value = state.url;
  status.textContent = [state.title, state.url].filter(Boolean).join(' · ');
  status.dataset.loading = String(Boolean(state.loading));
}

async function selectSession(id) {
  active = id;
  for (const button of list.querySelectorAll('button')) button.classList.toggle('active', button.dataset.id === id);
  const value = address.value.trim();
  const state = await window.poc.show(id, value || 'about:blank');
  renderState(state);
}

async function load() {
  const sessions = await window.poc.listSessions();
  list.replaceChildren(...sessions.map(session => {
    const button = document.createElement('button');
    button.dataset.id = session.id;
    button.textContent = session.title;
    button.title = session.thread_id ? `Thread ${session.thread_id}` : session.id;
    button.addEventListener('click', () => void selectSession(session.id));
    return button;
  }));
  const details = await window.poc.info();
  info.textContent = `库：${details.database}\nCDP：127.0.0.1:${details.debugPort}`;
  window.poc.onChanged(state => renderState(state));
  if (sessions[0]) await selectSession(sessions[0].id);
}

document.getElementById('open').addEventListener('click', async () => {
  if (active) renderState(await window.poc.navigate(active, address.value));
});
address.addEventListener('keydown', event => {
  if (event.key === 'Enter' && active) void window.poc.navigate(active, address.value).then(renderState);
});
for (const [id, action] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload']]) {
  document.getElementById(id).addEventListener('click', async () => {
    if (active) renderState(await window.poc.history(active, action));
  });
}

void load();
