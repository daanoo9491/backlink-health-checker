/**
 * LinkLedger SEO – Google index helper (background).
 *
 * While "running", it takes a few links at a time from LinkLedger, opens a
 * Google search for each in its own minimised window, reads the results and
 * reports Found / Not found back to LinkLedger. It goes at a person's pace
 * (a pause of several seconds between searches, and a daily limit), and if
 * Google asks "are you a robot?" it stops and shows you the page: you answer
 * it yourself, then press Resume. It never tries to get round that check.
 */
import { judge, searchFor } from './lib/google.js';
import { readGooglePage } from './lib/page.js';

const DEFAULTS = {
  appUrl: '',
  token: '',
  email: '',
  running: false,
  state: 'idle', // idle | running | waiting | captcha | consent | limit | error | disconnected
  message: '',
  dailyLimit: 400,
  minDelay: 8,
  maxDelay: 16,
  todayDate: '',
  todayCount: 0,
  windowId: null,
  tabId: null,
};
const PAGE_TIMEOUT_MS = 30_000;
const CLAIM_SIZE = 3;

const get = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });
const set = (patch) => chrome.storage.local.set(patch);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

async function setState(state, message = '') {
  await set({ state, message });
  const badge = { captcha: '!', consent: '!', error: 'err', limit: 'max', disconnected: 'off' }[state] ?? '';
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: state === 'limit' ? '#4f6068' : '#a3241b' });
}

class NotConnected extends Error {}

async function api(path, body) {
  const s = await get();
  const res = await fetch(`${s.appUrl}/api/helper${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
  });
  if (res.status === 401) throw new NotConnected();
  if (!res.ok) throw new Error(`LinkLedger answered HTTP ${res.status}`);
  return res.json();
}

// ---------- the Google window ----------

async function helperTab(url) {
  const s = await get();
  if (s.tabId !== null) {
    try {
      await chrome.tabs.update(s.tabId, { url });
      return s.tabId;
    } catch {
      /* the window was closed: make a new one */
    }
  }
  const win = await chrome.windows.create({ url, state: 'minimized' });
  const tabId = win.tabs[0].id;
  await set({ windowId: win.id, tabId });
  return tabId;
}

function loaded(tabId) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    const timer = setTimeout(() => done(false), PAGE_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function readSearch(url) {
  const tabId = await helperTab(url);
  if (!(await loaded(tabId))) return { kind: 'offline' };
  await sleep(700); // let late parts of the page settle
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: readGooglePage });
    return frame?.result ?? null;
  } catch {
    return { kind: 'offline' }; // Chrome's "no internet" page can't be read
  }
}

async function showGoogle() {
  const s = await get();
  try {
    if (s.windowId !== null) await chrome.windows.update(s.windowId, { state: 'normal', focused: true });
  } catch {
    /* already closed */
  }
}

async function hideGoogle() {
  const s = await get();
  try {
    if (s.windowId !== null) await chrome.windows.update(s.windowId, { state: 'minimized' });
  } catch {
    /* already closed */
  }
}

// ---------- the loop ----------

let looping = false;

async function loop() {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      let s = await get();
      if (!s.running || !s.token || !s.appUrl) return;
      if (['captcha', 'consent', 'disconnected'].includes(s.state)) return;

      if (s.todayDate !== today()) await set({ todayDate: today(), todayCount: 0 });
      s = await get();
      if (s.todayCount >= s.dailyLimit) {
        await setState(
          'limit',
          `Today’s limit of ${s.dailyLimit} searches is reached. The helper carries on tomorrow.`,
        );
        return;
      }

      const { jobs } = await api('/claim', { max: Math.min(CLAIM_SIZE, s.dailyLimit - s.todayCount) });
      if (!jobs.length) {
        await setState('waiting', 'All caught up. New index checks are picked up automatically.');
        return;
      }
      await setState('running', `Searching Google for ${jobs.length} link${jobs.length === 1 ? '' : 's'}…`);

      const results = [];
      let stop = null;
      for (const [n, job] of jobs.entries()) {
        const { query, url } = searchFor(job.url);
        const verdict = judge(job.url, await readSearch(url));
        if (['CAPTCHA', 'CONSENT', 'OFFLINE'].includes(verdict.outcome)) {
          stop = verdict.outcome;
          // Hand this link and the rest straight back, without counting a try.
          for (const left of jobs.slice(n)) results.push({ id: left.id, outcome: 'SKIP' });
          break;
        }
        results.push({
          id: job.id,
          outcome: verdict.outcome,
          query,
          resultCount: verdict.resultCount,
          why: verdict.why,
        });
        const st = await get();
        await set({ todayCount: st.todayCount + 1 });
        const wait = (st.minDelay + Math.random() * (st.maxDelay - st.minDelay)) * 1000;
        await sleep(wait);
      }
      if (results.length) await api('/results', { results });

      if (stop === 'CAPTCHA') {
        await showGoogle();
        await setState(
          'captcha',
          'Google wants to check you’re not a robot. Answer it in the Google window, then press Resume.',
        );
        return;
      }
      if (stop === 'OFFLINE') {
        await setState(
          'error',
          'Couldn’t reach Google. Check the internet connection; the helper tries again in a minute.',
        );
        return;
      }
      if (stop === 'CONSENT') {
        await showGoogle();
        await setState(
          'consent',
          'Google is asking about cookies. Choose an option in the Google window, then press Resume.',
        );
        return;
      }
    }
  } catch (e) {
    if (e instanceof NotConnected) {
      await set({ running: false });
      await setState(
        'disconnected',
        'The connection code isn’t valid any more. Create a new one in LinkLedger → Settings.',
      );
    } else {
      await setState('error', `${e?.message ?? e}. The helper tries again in a minute.`);
    }
  } finally {
    looping = false;
  }
}

// ---------- wake-ups and messages from the popup ----------

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(async () => {
  const s = await get();
  if (s.running && (s.state === 'error' || s.state === 'waiting' || s.state === 'limit' || s.state === 'running')) {
    if (s.state !== 'running') await setState('running', 'Looking for links to check…');
    loop();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'connect') {
      await set({ appUrl: msg.appUrl, token: msg.token, running: false });
      try {
        const status = await api('/status');
        await set({ email: status.email });
        await setState('idle', 'Connected. Press Start to begin.');
        reply({ ok: true, status });
      } catch (e) {
        await set({ token: '' });
        reply({
          ok: false,
          error: e instanceof NotConnected ? 'That code isn’t valid.' : `Couldn’t reach LinkLedger (${e.message}).`,
        });
      }
      return;
    }
    if (msg.type === 'status') {
      try {
        reply({ ok: true, status: await api('/status') });
      } catch (e) {
        reply({ ok: false, error: e instanceof NotConnected ? 'Not connected.' : e.message });
      }
      return;
    }
    if (msg.type === 'start' || msg.type === 'resume') {
      await set({ running: true });
      await setState('running', 'Starting…');
      await hideGoogle();
      loop();
    } else if (msg.type === 'pause') {
      await set({ running: false });
      await setState('idle', 'Paused.');
    } else if (msg.type === 'disconnect') {
      await set({ running: false, token: '', email: '' });
      await setState('idle', '');
    } else if (msg.type === 'settings') {
      const dailyLimit = Math.min(2000, Math.max(10, Number(msg.dailyLimit) || DEFAULTS.dailyLimit));
      await set({ dailyLimit });
    }
    reply({ ok: true });
  })();
  return true; // reply asynchronously
});
