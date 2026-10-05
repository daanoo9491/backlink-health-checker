/** Popup: connect, start/pause/resume, and show progress. */
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function showError(text) {
  $('error').textContent = text || '';
  $('error').hidden = !text;
}

async function render() {
  const s = await chrome.storage.local.get(null);
  const connected = !!(s.token && s.appUrl);
  $('connect').hidden = connected;
  $('main').hidden = !connected;
  if (!connected) {
    $('appUrl').value = s.appUrl || '';
    return;
  }
  $('email').textContent = s.email || '';
  $('message').textContent = s.message || '';
  $('message').className =
    `message${['captcha', 'consent', 'error', 'disconnected', 'limit'].includes(s.state) ? ' warn' : ''}`;
  const paused = s.state === 'captcha' || s.state === 'consent';
  $('startBtn').hidden = !!s.running || paused;
  $('resumeBtn').hidden = !paused;
  $('pauseBtn').hidden = !s.running;
  $('limit').value = s.dailyLimit || 400;
  $('today').textContent = s.todayDate === new Date().toLocaleDateString('en-CA') ? String(s.todayCount || 0) : '0';
}

async function refreshCounts() {
  const r = await send({ type: 'status' });
  if (r?.ok) $('pending').textContent = String(r.status.pending);
}

$('connectBtn').addEventListener('click', async () => {
  showError('');
  let origin;
  try {
    origin = new URL($('appUrl').value.trim()).origin;
  } catch {
    showError('Enter the LinkLedger address, e.g. https://….workers.dev');
    return;
  }
  const token = $('token').value.trim();
  if (!token.startsWith('llh_')) {
    showError('The connection code starts with llh_.');
    return;
  }
  // workers.dev and localhost are allowed already; any other address needs your OK once.
  const known = /\.workers\.dev$|^localhost$|^127\.0\.0\.1$/.test(new URL(origin).hostname);
  if (!known && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    showError('The helper needs permission to talk to that address.');
    return;
  }
  const r = await send({ type: 'connect', appUrl: origin, token });
  if (!r?.ok) showError(r?.error || 'Couldn’t connect.');
  await render();
  await refreshCounts();
});

$('startBtn').addEventListener('click', async () => send({ type: 'start' }).then(render));
$('resumeBtn').addEventListener('click', async () => send({ type: 'resume' }).then(render));
$('pauseBtn').addEventListener('click', async () => send({ type: 'pause' }).then(render));
$('disconnectBtn').addEventListener('click', async () => send({ type: 'disconnect' }).then(render));
$('limit').addEventListener('change', async () => send({ type: 'settings', dailyLimit: $('limit').value }));

chrome.storage.onChanged.addListener(() => render());
render().then(refreshCounts);
setInterval(refreshCounts, 10_000);
