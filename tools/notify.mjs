// Fennec Job Board: timed phone notifications (runs on GitHub Actions).
//  - 8:01 am (New York): tells Salah which workers with jobs today haven't tapped Ready.
//  - 8:00 pm (New York): sends each person the list of their jobs for tomorrow.
// Needs the GitHub secret BOT_PASSWORD: the password of the Firebase login bot@the-fennec.com.
// Notifications go through the free ntfy app (https://ntfy.sh). They hold the time, appliance and town only:
// customer names, phone numbers and street addresses stay inside the board.

const API_KEY = 'AIzaSyCIRh114KrUBnrr3hiLMOVOSnQi7ih_--c'; // public web key, same as the board page
const PROJECT = 'fennec-jobs';
const BOT = 'bot@the-fennec.com';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SLOTS = { 1: ['Finish job', '7:30'], 2: ['Job 1', '9:00'], 3: ['Finish job', '11:00'], 4: ['Job 2', '1:00'], 5: ['Job 3', '3:00'], 6: ['Finish job', 'After 5:00'] };
const LATE_AT = 8 * 60 + 10;

function ny(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function niceDay(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
function town(a) { const p = String(a || '').split(',').map(x => x.trim()).filter(Boolean); return p.length > 1 ? p[p.length - 1] : ''; }

// Firestore REST values -> plain JS
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return fields(v.mapValue.fields);
  return null;
}
function fields(f) { return Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, val(v)])); }

async function signIn() {
  if (!process.env.BOT_PASSWORD) throw new Error('BOT_PASSWORD secret is missing');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOT, password: process.env.BOT_PASSWORD, returnSecureToken: true }),
  });
  if (!r.ok) throw new Error('Robot login failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).idToken;
}
async function getDoc(path, token) {
  const r = await fetch(`${BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Read ${path} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return fields((await r.json()).fields);
}
async function listJobs(token) {
  const out = []; let pageToken = '';
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${BASE}/jobs?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Read jobs failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), ...fields(d.fields) }));
    if (!j.nextPageToken) break; pageToken = j.nextPageToken;
  }
  return out;
}
// Each message is sent once a day: the first run claims sent/<kind>_<date>; later runs see it and stop.
async function claim(id, token) {
  const r = await fetch(`${BASE}/sent?documentId=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { at: { timestampValue: new Date().toISOString() } } }),
  });
  if (r.ok) return true;
  if (r.status === 409) return false;
  throw new Error(`Claim ${id} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function push(topic, title, body, tags) {
  if (!topic) { console.log('No channel for this person yet, skipped:', title); return; }
  const r = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
    method: 'POST', headers: { Title: title, Tags: tags || 'wrench', Click: 'https://the-fennec.com/jobs/' }, body,
  });
  console.log('Sent:', title, r.status);
}

async function main() {
  const now = ny();
  const forced = (process.env.MODE || '').trim();
  let mode = forced;
  if (!mode) {
    if (now.min >= 8 * 60 + 1 && now.min <= 9 * 60 + 30) mode = 'morning';
    else if (now.min >= 20 * 60 && now.min <= 21 * 60 + 30) mode = 'night';
    else { console.log('Not a send time in New York (' + now.ymd + ' ' + now.min + ' min). Nothing to do.'); return; }
  }
  const token = await signIn();
  const today = now.ymd;
  if (!forced && !(await claim(`${mode}_${today}`, token))) { console.log(mode + ' already sent today.'); return; }

  const topics = (await getDoc('notify/topics', token)) || {};
  const names = (await getDoc('public/names', token)) || {};
  const name = w => (w === 'o' ? 'Salah' : names[w] || (w === 'a' ? 'Mohamed' : 'Mahdi'));
  const jobs = await listJobs(token);

  if (mode === 'morning') {
    const notReady = [];
    for (const w of ['a', 'b']) {
      const hasJobs = jobs.some(j => j.worker === w && j.date === today && j.status !== 'part');
      if (!hasJobs) continue;
      const r = await getDoc(`ready/${w}_${today}`, token);
      const ok = r && r.at instanceof Date && ny(r.at).ymd === today;
      if (!ok) notReady.push(name(w));
    }
    if (notReady.length) await push(topics.o, 'Not ready yet: ' + notReady.join(' and '), `${notReady.join(' and ')} ${notReady.length > 1 ? "haven't" : "hasn't"} tapped Ready (8:01 am). After 8:10 it counts as late.`, 'warning');
    else console.log('Everyone with jobs today is ready.');
  }

  if (mode === 'night') {
    const tomorrow = addDays(today, 1);
    for (const w of ['o', 'a', 'b']) {
      const list = jobs.filter(j => j.worker === w && j.date === tomorrow && j.status === 'booked' && SLOTS[j.slot]).sort((x, y) => x.slot - y.slot);
      if (!list.length) continue;
      const lines = list.map(j => [SLOTS[j.slot][1], SLOTS[j.slot][0], [j.brand, j.appliance].filter(Boolean).join(' '), town(j.address)].filter(Boolean).join(' - '));
      const body = lines.join('\n') + (w === 'o' ? '' : '\nTap Ready by 8:10 am.');
      await push(topics[w], `Tomorrow ${niceDay(tomorrow)}: ${list.length} job${list.length > 1 ? 's' : ''}`, body, 'calendar');
    }
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
