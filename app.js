/* ===== Shank — app logic (v0.1.0) =====
 * v1 stores data in this browser (localStorage) so it works instantly.
 * v1.5 will swap the store() functions for Supabase so the crew shares one
 * leaderboard across phones. Keep all data access inside the Store object
 * below so that swap stays easy.
 */

/* ---------- Store (the only place that touches the cloud) ----------
 * Talks to Supabase. Keeps an in-memory copy of everything in `cache` so the
 * render functions can stay simple/synchronous. Only init() and the mutations
 * (add/remove) hit the network. The DB uses `player_id`; the app uses
 * `playerId` — the mapping happens right here so nothing else has to care. */
const sb = supabase.createClient(window.SHANK_CONFIG.url, window.SHANK_CONFIG.key);

// The signed-in Supabase session (null = browsing as a guest).
let session = null;
sb.auth.onAuthStateChange((_evt, s) => { session = s; });

const Store = {
  cache: { players: [], rounds: [] },

  newId() {
    // Globally-unique id so two phones logging at once never collide.
    return (crypto.randomUUID && crypto.randomUUID()) ||
      ('id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  },

  // Pull everything from the cloud once, on startup.
  async init() {
    const [pRes, rRes] = await Promise.all([
      sb.from('players').select('*'),
      sb.from('rounds').select('*'),
    ]);
    if (pRes.error) throw pRes.error;
    if (rRes.error) throw rRes.error;
    this.cache.players = (pRes.data || []).map(p => ({ id: p.id, name: p.name, userId: p.user_id }));
    this.cache.rounds = (rRes.data || []).map(r => ({
      id: r.id, playerId: r.player_id, score: r.score,
      par: r.par, course: r.course, date: r.date,
    }));
  },

  players() { return this.cache.players; },
  rounds() { return this.cache.rounds; },

  async addPlayer(name) {
    const p = { id: this.newId(), name: name.trim(), userId: session?.user?.id || null };
    const { error } = await sb.from('players').insert({ id: p.id, name: p.name, user_id: p.userId });
    if (error) throw error;
    this.cache.players.push(p);
    return p;
  },
  async removePlayer(id) {
    // Rounds first so nothing orphans if the player delete fails.
    const { error: rErr } = await sb.from('rounds').delete().eq('player_id', id);
    if (rErr) throw rErr;
    const { error } = await sb.from('players').delete().eq('id', id);
    if (error) throw error;
    this.cache.players = this.cache.players.filter(p => p.id !== id);
    this.cache.rounds = this.cache.rounds.filter(r => r.playerId !== id);
  },
  async addRound(round) {
    round.id = this.newId();
    const { error } = await sb.from('rounds').insert({
      id: round.id, player_id: round.playerId, score: round.score,
      par: round.par, course: round.course, date: round.date,
    });
    if (error) throw error;
    this.cache.rounds.push(round);
    return round;
  },
  async removeRound(id) {
    const { error } = await sb.from('rounds').delete().eq('id', id);
    if (error) throw error;
    this.cache.rounds = this.cache.rounds.filter(r => r.id !== id);
  },
  roundsFor(playerId) {
    return this.rounds()
      .filter(r => r.playerId === playerId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  },
};

/* ---------- Golf math ---------- */
// Simplified handicap: differential = score - par for each round.
// Take the best (lowest) ~half of a player's differentials, average them,
// times 0.96 (the real-handicap "bonus for excellence" factor).
// Needs >= 1 round; gets more accurate with more rounds.
function handicap(playerId) {
  const diffs = Store.roundsFor(playerId).map(r => r.score - (r.par || 72));
  if (!diffs.length) return null;
  const sorted = [...diffs].sort((a, b) => a - b);
  const useCount = Math.max(1, Math.ceil(sorted.length / 2));
  const best = sorted.slice(0, useCount);
  const avg = best.reduce((s, d) => s + d, 0) / best.length;
  return Math.round(avg * 0.96 * 10) / 10;
}

function playerSummary(p) {
  const rounds = Store.roundsFor(p.id);
  const scores = rounds.map(r => r.score);
  return {
    id: p.id,
    name: p.name,
    rounds: rounds.length,
    hcp: handicap(p.id),
    avg: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
    best: scores.length ? Math.min(...scores) : null,
  };
}

/* ---------- Season records (the trash-talk fuel) ---------- */
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function stddev(arr) {
  const m = avg(arr);
  return Math.sqrt(avg(arr.map(x => (x - m) ** 2)));
}
function fmtToPar(n) { return n > 0 ? `+${n}` : n === 0 ? 'E' : `${n}`; }

function computeRecords() {
  const players = Store.players();
  const recs = [];

  // Every round flattened, with who shot it (to-par).
  const all = [];
  players.forEach(p => Store.roundsFor(p.id).forEach(r =>
    all.push({ name: p.name, toPar: r.score - (r.par || 72), score: r.score })));

  if (all.length) {
    const low = all.reduce((a, b) => (b.toPar < a.toPar ? b : a));
    recs.push({ icon: '🔥', label: 'Lowest Round', who: low.name, value: `${low.score} (${fmtToPar(low.toPar)})` });
    const high = all.reduce((a, b) => (b.toPar > a.toPar ? b : a));
    recs.push({ icon: '💣', label: 'Biggest Blowup', who: high.name, value: `${high.score} (${fmtToPar(high.toPar)})` });
  }

  // Most rounds played (only brag-worthy at 2+).
  const counts = players.map(p => ({ name: p.name, n: Store.roundsFor(p.id).length })).filter(x => x.n > 0);
  if (counts.length) {
    const most = counts.reduce((a, b) => (b.n > a.n ? b : a));
    if (most.n >= 2) recs.push({ icon: '🏌️', label: 'Most Rounds', who: most.name, value: `${most.n} rounds` });
  }

  // Most improved: first-half avg vs second-half avg (needs 4+ rounds).
  let bestImp = null;
  players.forEach(p => {
    const tp = Store.roundsFor(p.id).slice().reverse().map(r => r.score - (r.par || 72)); // oldest first
    if (tp.length >= 4) {
      const half = Math.floor(tp.length / 2);
      const imp = avg(tp.slice(0, half)) - avg(tp.slice(tp.length - half));
      if (imp > 0 && (!bestImp || imp > bestImp.imp)) bestImp = { name: p.name, imp };
    }
  });
  if (bestImp) recs.push({ icon: '📈', label: 'Most Improved', who: bestImp.name, value: `${bestImp.imp.toFixed(1)} strokes better` });

  // Most consistent: lowest spread in scores (needs 3+ rounds).
  let bestCons = null;
  players.forEach(p => {
    const tp = Store.roundsFor(p.id).map(r => r.score - (r.par || 72));
    if (tp.length >= 3) {
      const sd = stddev(tp);
      if (!bestCons || sd < bestCons.sd) bestCons = { name: p.name, sd };
    }
  });
  if (bestCons) recs.push({ icon: '🎯', label: 'Most Consistent', who: bestCons.name, value: `±${bestCons.sd.toFixed(1)} strokes` });

  return recs;
}

function renderRecords() {
  const section = document.getElementById('records-section');
  const list = document.getElementById('records-list');
  const recs = computeRecords();
  if (!recs.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  list.innerHTML = recs.map(r => `
    <div class="record">
      <div class="record-ico">${r.icon}</div>
      <div class="record-body">
        <div class="record-label">${r.label}</div>
        <div class="record-who">${esc(r.who)}</div>
        <div class="record-val">${esc(r.value)}</div>
      </div>
    </div>`).join('');
}

/* ---------- Auth ---------- */
function myPlayer() {
  return session ? Store.players().find(p => p.userId === session.user.id) : null;
}

function updateAuthUI() {
  const btn = document.getElementById('auth-btn');
  if (session) {
    const me = myPlayer();
    btn.textContent = me ? me.name : 'Account';
  } else {
    btn.textContent = 'Sign in';
  }
}

document.getElementById('auth-btn').addEventListener('click', async () => {
  if (!session) return show('auth');
  if (confirm('Sign out of Shank?')) {
    await sb.auth.signOut();
    location.reload();
  }
});

let authMode = 'signup';
function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('auth-title').textContent = mode === 'signup' ? 'Join the crew' : 'Welcome back';
  document.getElementById('auth-sub').textContent = mode === 'signup'
    ? 'Create your account — your name goes on the board.'
    : 'Sign in to log your rounds.';
  document.getElementById('auth-name-field').classList.toggle('hidden', mode !== 'signup');
  document.getElementById('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  document.getElementById('auth-switch-label').textContent = mode === 'signup' ? 'Already have an account?' : 'New here?';
  document.getElementById('auth-toggle').textContent = mode === 'signup' ? 'Sign in' : 'Sign up';
}
document.getElementById('auth-toggle').addEventListener('click', () =>
  setAuthMode(authMode === 'signup' ? 'signin' : 'signup'));

document.getElementById('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('auth-msg');
  const btn = document.getElementById('auth-submit');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value.trim();
  if (authMode === 'signup' && !name) return flash(msg, 'Pick a name for the board.', 'err');
  btn.disabled = true;
  try {
    if (authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        // Email confirmations are on in Supabase: account made, not signed in yet.
        msg.textContent = 'Check your email to confirm your account, then sign in.';
        msg.className = 'form-msg ok';
        return;
      }
      session = data.session;
      await Store.addPlayer(name);
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    location.reload(); // fresh data + replays the splash
  } catch (err) {
    flash(msg, err.message || 'Something went wrong.', 'err');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('add-gate-btn').addEventListener('click', () => show('auth'));

/* ---------- Navigation ---------- */
const views = ['leaderboard', 'add', 'players', 'detail', 'auth'];
function show(view, ctx) {
  views.forEach(v => document.getElementById('view-' + v).classList.toggle('hidden', v !== view));
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('is-active', t.dataset.nav === view);
  });
  if (view === 'leaderboard') renderLeaderboard();
  if (view === 'add') prepAddForm();
  if (view === 'players') renderPlayers();
  if (view === 'detail') renderDetail(ctx);
}

document.querySelectorAll('[data-nav]').forEach(el => {
  el.addEventListener('click', () => show(el.dataset.nav));
});

// Tapping the Shank logo reloads the app, which replays the splash.
document.querySelector('.brand').addEventListener('click', () => location.reload());

/* ---------- Version history ---------- */
const CHANGELOG = [
  { v: '0.6.0', title: 'Home turf', notes: [
    '38 courses around Vaughan & the GTA built in — type a couple letters and pick',
    'Par fills in automatically for every built-in course',
  ]},
  { v: '0.5.2', title: 'Course memory', notes: [
    'Typing a course suggests ones the crew has played',
    'Picking a known course fills in its par automatically',
  ]},
  { v: '0.5.1', title: 'No mystery rounds', notes: [
    'Course is now required when logging a round',
  ]},
  { v: '0.5.0', title: 'Get your own account', notes: [
    'Sign up with email + password — your name, your scores',
    'Only you can log or delete your own rounds',
    'Anyone with the link can still view the board',
  ]},
  { v: '0.4.0', title: 'The glow-up', notes: [
    'Whole new look: fancy fonts, medal rank badges, frosted tab bar',
    'Opening animation — tee shot straight into your face',
    'Tap the logo to replay it',
    'Version history (you\'re looking at it)',
  ]},
  { v: '0.3.0', title: 'Trash-talk fuel', notes: [
    'Season records: lowest round, biggest blowup, most improved & more',
    'Recent form chips on player pages',
    'Delete a single round',
  ]},
  { v: '0.2.0', title: 'The crew goes cloud', notes: [
    'Scores sync through the cloud — one shared leaderboard for everyone',
    'Live on the web for the whole crew',
  ]},
  { v: '0.1.0', title: 'First swing', notes: [
    'Log rounds, auto handicaps, season leaderboard',
    'Data lived on your phone only',
  ]},
];

const changelogOverlay = document.getElementById('changelog-overlay');
document.getElementById('version-btn').addEventListener('click', () => {
  document.getElementById('changelog-list').innerHTML = CHANGELOG.map(c => `
    <div class="ver-row">
      <div class="ver-head"><span class="ver-num">v${c.v}</span><span class="ver-title">${esc(c.title)}</span></div>
      <ul class="ver-notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    </div>`).join('');
  changelogOverlay.classList.remove('hidden');
});
document.getElementById('changelog-close').addEventListener('click', () =>
  changelogOverlay.classList.add('hidden'));
changelogOverlay.addEventListener('click', e => {
  if (e.target === changelogOverlay) changelogOverlay.classList.add('hidden');
});

/* ---------- Renderers ---------- */
// Example board shown before any real rounds exist, so the Board tab
// demos what the crew is playing for instead of sitting empty.
const DEMO_BOARD = [
  { name: 'Scottie Scheffler', rounds: 9, hcp: '+8.4', avg: 68, best: 62 },
  { name: 'Rory McIlroy',      rounds: 8, hcp: '+7.9', avg: 69, best: 63 },
  { name: 'Tiger Woods',       rounds: 6, hcp: '+7.1', avg: 70, best: 61 },
  { name: 'Bryson DeChambeau', rounds: 7, hcp: '+6.8', avg: 70, best: 58 },
];

function renderLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  const empty = document.getElementById('leaderboard-empty');
  const summaries = Store.players()
    .map(playerSummary)
    .filter(s => s.rounds > 0)
    .sort((a, b) => a.hcp - b.hcp); // lowest handicap wins

  if (!summaries.length) {
    empty.classList.add('hidden');
    list.innerHTML = `
      <div class="demo-banner">
        <p><strong>No rounds yet</strong> — here's a sneak peek of your board.</p>
        <button class="btn btn-primary btn-small" id="demo-cta">${session ? 'Log a round' : 'Join the board'}</button>
      </div>` + DEMO_BOARD.map((s, i) => `
      <div class="card demo">
        <div class="rank rank-${i + 1}">${i === 0 ? '🥇' : i + 1}</div>
        <div class="lb-main">
          <div class="lb-name">${esc(s.name)}<span class="demo-chip">example</span></div>
          <div class="lb-meta">${s.rounds} rounds · avg ${s.avg} · best ${s.best}</div>
        </div>
        <div class="lb-hcp">
          <div class="num">${s.hcp}</div>
          <div class="lbl">hcp</div>
        </div>
      </div>`).join('');
    document.getElementById('demo-cta').addEventListener('click', () => show(session ? 'add' : 'auth'));
    renderRecords();
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = summaries.map((s, i) => `
    <div class="card tappable" data-player="${s.id}">
      <div class="rank rank-${i + 1}">${i === 0 ? '🥇' : i + 1}</div>
      <div class="lb-main">
        <div class="lb-name">${esc(s.name)}</div>
        <div class="lb-meta">${s.rounds} round${s.rounds === 1 ? '' : 's'} · avg ${s.avg} · best ${s.best}</div>
      </div>
      <div class="lb-hcp">
        <div class="num">${s.hcp}</div>
        <div class="lbl">hcp</div>
      </div>
    </div>`).join('');
  bindPlayerTaps(list);
  renderRecords();
}

function renderPlayers() {
  const list = document.getElementById('players-list');
  const empty = document.getElementById('players-empty');
  const players = Store.players();
  // The claim-a-name form only shows for signed-in users without a player
  // (normally the player is created at signup; this is the fallback).
  document.getElementById('player-form').classList.toggle('hidden', !(session && !myPlayer()));
  empty.classList.toggle('hidden', players.length > 0);
  list.innerHTML = players.map(p => {
    const s = playerSummary(p);
    return `
    <div class="card tappable" data-player="${p.id}">
      <div class="lb-main">
        <div class="lb-name">${esc(p.name)}</div>
        <div class="lb-meta">${s.rounds ? `hcp ${s.hcp} · ${s.rounds} round${s.rounds === 1 ? '' : 's'}` : 'no rounds yet'}</div>
      </div>
      <div class="chev">›</div>
    </div>`;
  }).join('');
  bindPlayerTaps(list);
}

function renderDetail(id) {
  const p = Store.players().find(x => x.id === id);
  if (!p) return show('players');
  show.lastDetail = id;
  const mine = !!(session && p.userId === session.user.id);
  const s = playerSummary(p);
  document.getElementById('detail-name').textContent = p.name + (mine ? ' (you)' : '');
  document.getElementById('detail-stats').innerHTML = `
    <div class="stat"><div class="num">${s.hcp ?? '—'}</div><div class="lbl">Handicap</div></div>
    <div class="stat"><div class="num">${s.rounds}</div><div class="lbl">Rounds played</div></div>
    <div class="stat"><div class="num">${s.avg ?? '—'}</div><div class="lbl">Avg score</div></div>
    <div class="stat"><div class="num">${s.best ?? '—'}</div><div class="lbl">Best round</div></div>`;

  const rounds = Store.roundsFor(p.id);

  // Recent form: up to last 5 rounds, oldest→newest so the trend reads left to right.
  const formEl = document.getElementById('detail-form');
  if (rounds.length) {
    const recent = rounds.slice(0, 5).reverse();
    formEl.innerHTML = `<div class="form-strip">
      <span class="form-label">Recent form</span>
      <div class="form-chips">${recent.map(r => {
        const tp = r.score - (r.par || 72);
        const cls = tp > 0 ? 'pos' : tp < 0 ? 'neg' : '';
        return `<span class="form-chip ${cls}">${fmtToPar(tp)}</span>`;
      }).join('')}</div>
    </div>`;
  } else {
    formEl.innerHTML = '';
  }

  const box = document.getElementById('detail-rounds');
  if (!rounds.length) {
    box.innerHTML = '<p class="muted">No rounds logged yet.</p>';
  } else {
    box.innerHTML = rounds.map(r => {
      const overRaw = r.score - (r.par || 72);
      const cls = overRaw > 0 ? 'pos' : overRaw < 0 ? 'neg' : '';
      const over = overRaw > 0 ? `+${overRaw}` : overRaw === 0 ? 'E' : overRaw;
      return `
      <div class="card round-row">
        <div>
          <div class="round-score">${r.score} <span class="over-par ${cls}">${over}</span></div>
          <div class="round-info">${esc(r.course || 'Unknown course')} · ${fmtDate(r.date)}</div>
        </div>
        ${mine ? `<button class="round-del" data-round="${r.id}" title="Delete round">✕</button>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll('.round-del').forEach(b => {
      b.addEventListener('click', async () => {
        if (confirm('Delete this round? This can\'t be undone.')) {
          try { await Store.removeRound(b.dataset.round); renderDetail(p.id); }
          catch (err) { alert('Could not delete: ' + err.message); }
        }
      });
    });
  }
  const delBtn = document.getElementById('detail-delete');
  delBtn.classList.toggle('hidden', !mine);
  delBtn.onclick = !mine ? null : async () => {
    if (confirm(`Remove ${p.name} and all their rounds? This can't be undone.`)) {
      try {
        await Store.removePlayer(p.id);
        show('players');
      } catch (err) { alert('Could not remove player: ' + err.message); }
    }
  };
}

function bindPlayerTaps(container) {
  container.querySelectorAll('[data-player]').forEach(el => {
    el.addEventListener('click', () => show('detail', el.dataset.player));
  });
}

/* ---------- Add Round form ---------- */
// Built-in courses around Vaughan & the GTA north so suggestions work from
// day one and everyone spells them the same way. Pars are best-known; if a
// round gets logged with a corrected par, the logged par wins from then on.
const BUILTIN_COURSES = [
  // Vaughan / Woodbridge / Kleinburg / Maple / Thornhill
  { name: 'Eagles Nest Golf Club', par: 72 },
  { name: 'Copper Creek Golf Club', par: 72 },
  { name: 'Kleinburg Golf Club', par: 72 },
  { name: 'Kirby Links (par 3)', par: 54 },
  { name: 'The National Golf Club of Canada', par: 72 },
  { name: 'The Country Club (Woodbridge)', par: 72 },
  { name: 'Uplands Golf & Ski (9 holes)', par: 35 },
  { name: 'Thornhill Club', par: 71 },
  { name: 'Maple Downs Golf & Country Club', par: 72 },
  // Richmond Hill
  { name: 'Richmond Hill Golf Club', par: 70 },
  { name: 'Bathurst Glen Golf Club', par: 70 },
  { name: 'Bloomington Downs Golf Club', par: 72 },
  { name: 'DiamondBack Golf Club', par: 72 },
  // Markham / Gormley / Stouffville
  { name: 'Angus Glen North', par: 72 },
  { name: 'Angus Glen South', par: 72 },
  { name: 'Remington Parkview Golf & Country Club', par: 72 },
  { name: 'Station Creek Golf Club', par: 72 },
  { name: 'Emerald Hills Golf Club', par: 72 },
  { name: 'Spring Lakes Golf Club', par: 72 },
  { name: 'Ballantrae Golf Club', par: 72 },
  { name: 'Sleepy Hollow Country Club', par: 72 },
  // Aurora / Newmarket / King / Nobleton
  { name: "St. Andrew's Valley Golf Club", par: 72 },
  { name: 'Westview Golf Club', par: 72 },
  { name: 'Cardinal Golf Club', par: 72 },
  { name: 'Cardinal RedCrest', par: 72 },
  { name: 'Nobleton Lakes Golf Club', par: 72 },
  { name: 'Carrying Place Golf & Country Club', par: 72 },
  { name: 'Silver Lakes Golf & Country Club', par: 72 },
  { name: 'Pheasant Run Golf Club', par: 72 },
  // Bolton / Caledon / Brampton
  { name: 'Glen Eagle Golf Club', par: 72 },
  { name: 'Caledon Woods Golf Club', par: 72 },
  { name: 'Lionhead Legends', par: 72 },
  { name: 'Lionhead Masters', par: 72 },
  { name: 'Turnberry Golf Club', par: 70 },
  // Toronto city courses (cheap & public)
  { name: 'Don Valley Golf Course', par: 71 },
  { name: 'Humber Valley Golf Course', par: 70 },
  { name: 'Scarlett Woods (executive)', par: 62 },
  { name: 'Royal Woodbine Golf Club', par: 71 },
];

// Courses the crew has played, with the par used last time: typing a known
// course suggests it, and picking it auto-fills the par.
let coursePars = {};

function prepAddForm() {
  const me = myPlayer();
  document.getElementById('add-gate').classList.toggle('hidden', !!me);
  document.getElementById('round-form').classList.toggle('hidden', !me);
  if (!me) return;
  // You log your own rounds — the player is always you.
  const sel = document.getElementById('round-player');
  sel.innerHTML = `<option value="${me.id}">${esc(me.name)}</option>`;
  const dateInput = document.getElementById('round-date');
  if (!dateInput.value) dateInput.value = todayStr();

  coursePars = {};
  BUILTIN_COURSES.forEach(c => { coursePars[c.name.toLowerCase()] = { name: c.name, par: c.par }; });
  Store.rounds()
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1)) // oldest first, newest par wins
    .forEach(r => {
      const name = (r.course || '').trim();
      if (name) coursePars[name.toLowerCase()] = { name, par: r.par || 72 };
    });
  document.getElementById('course-list').innerHTML =
    Object.values(coursePars)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${esc(c.name)}"></option>`).join('');
}

document.getElementById('round-course').addEventListener('input', e => {
  const hit = coursePars[e.target.value.trim().toLowerCase()];
  if (hit) document.getElementById('round-par').value = hit.par;
});

document.getElementById('round-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('round-msg');
  const btn = e.target.querySelector('button[type="submit"]');
  const playerId = document.getElementById('round-player').value;
  const score = parseInt(document.getElementById('round-score').value, 10);
  const par = parseInt(document.getElementById('round-par').value, 10) || 72;
  const course = document.getElementById('round-course').value.trim();
  const date = document.getElementById('round-date').value;

  if (!playerId) { return flash(msg, 'Add a player first (Players tab).', 'err'); }
  if (!score || score < 18) { return flash(msg, 'Enter a real score.', 'err'); }
  if (!course) { return flash(msg, 'Where did you play? Course is required.', 'err'); }

  btn.disabled = true;
  flash(msg, 'Saving…', 'ok');
  try {
    await Store.addRound({ playerId, score, par, course, date });
    e.target.reset();
    document.getElementById('round-par').value = 72;
    flash(msg, '⛳ Round saved! Check the board.', 'ok');
  } catch (err) {
    flash(msg, 'Could not save: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('player-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('player-name');
  const btn = e.target.querySelector('button[type="submit"]');
  const name = input.value.trim();
  if (!name) return;
  btn.disabled = true;
  try {
    await Store.addPlayer(name);
    input.value = '';
    renderPlayers();
    updateAuthUI();
  } catch (err) {
    alert('Could not add player: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Helpers ---------- */
function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flash(el, text, kind) {
  el.textContent = text;
  el.className = 'form-msg ' + kind;
  if (kind === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'form-msg'; }, 2500);
}
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[+m - 1]} ${+day}, ${y}`;
}
function todayStr() {
  // local date in YYYY-MM-DD without relying on toISOString (UTC) edge cases
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- Splash ---------- */
// The splash doubles as the loading screen: it stays up until the data has
// arrived AND the animation has had time to land (min 4s), then fades out.
const SPLASH_MIN_MS = 4000;
function dismissSplash(startedAt) {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - startedAt));
  setTimeout(() => {
    splash.classList.add('splash-out');
    setTimeout(() => splash.remove(), 500);
  }, wait);
}

/* ---------- Boot ---------- */
async function boot() {
  const splashStart = Date.now();
  const list = document.getElementById('leaderboard-list');
  const sub = document.getElementById('leaderboard-sub');
  sub.textContent = 'Loading the crew from the cloud…';
  try {
    const { data } = await sb.auth.getSession();
    session = data.session;
    await Store.init();
    updateAuthUI();
    sub.textContent = 'Ranked by handicap — lowest wins.';
    show('leaderboard');
  } catch (err) {
    sub.textContent = '';
    list.innerHTML = `<div class="empty">
      <p class="empty-emoji">⚠️</p>
      <p>Couldn't reach the cloud.</p>
      <p class="muted">${esc(err.message || 'Check your connection and refresh.')}</p>
    </div>`;
  } finally {
    dismissSplash(splashStart);
  }
}
boot();
