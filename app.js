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
    this.cache.players = (pRes.data || []).map(p => ({ id: p.id, name: p.name }));
    this.cache.rounds = (rRes.data || []).map(r => ({
      id: r.id, playerId: r.player_id, score: r.score,
      par: r.par, course: r.course, date: r.date,
    }));
  },

  players() { return this.cache.players; },
  rounds() { return this.cache.rounds; },

  async addPlayer(name) {
    const p = { id: this.newId(), name: name.trim() };
    const { error } = await sb.from('players').insert({ id: p.id, name: p.name });
    if (error) throw error;
    this.cache.players.push(p);
    return p;
  },
  async removePlayer(id) {
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

/* ---------- Navigation ---------- */
const views = ['leaderboard', 'add', 'players', 'detail'];
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

/* ---------- Renderers ---------- */
function renderLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  const empty = document.getElementById('leaderboard-empty');
  const summaries = Store.players()
    .map(playerSummary)
    .filter(s => s.rounds > 0)
    .sort((a, b) => a.hcp - b.hcp); // lowest handicap wins

  if (!summaries.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
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
}

function renderPlayers() {
  const list = document.getElementById('players-list');
  const empty = document.getElementById('players-empty');
  const players = Store.players();
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
  const s = playerSummary(p);
  document.getElementById('detail-name').textContent = p.name;
  document.getElementById('detail-stats').innerHTML = `
    <div class="stat"><div class="num">${s.hcp ?? '—'}</div><div class="lbl">Handicap</div></div>
    <div class="stat"><div class="num">${s.rounds}</div><div class="lbl">Rounds played</div></div>
    <div class="stat"><div class="num">${s.avg ?? '—'}</div><div class="lbl">Avg score</div></div>
    <div class="stat"><div class="num">${s.best ?? '—'}</div><div class="lbl">Best round</div></div>`;

  const rounds = Store.roundsFor(p.id);
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
      </div>`;
    }).join('');
  }
  document.getElementById('detail-delete').onclick = async () => {
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
function prepAddForm() {
  const sel = document.getElementById('round-player');
  const players = Store.players();
  sel.innerHTML = players.length
    ? players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="" disabled selected>Add a player first →</option>';
  const dateInput = document.getElementById('round-date');
  if (!dateInput.value) dateInput.value = todayStr();
}

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

/* ---------- Boot ---------- */
async function boot() {
  const list = document.getElementById('leaderboard-list');
  const sub = document.getElementById('leaderboard-sub');
  sub.textContent = 'Loading the crew from the cloud…';
  try {
    await Store.init();
    sub.textContent = 'Ranked by handicap — lowest wins.';
    show('leaderboard');
  } catch (err) {
    sub.textContent = '';
    list.innerHTML = `<div class="empty">
      <p class="empty-emoji">⚠️</p>
      <p>Couldn't reach the cloud.</p>
      <p class="muted">${esc(err.message || 'Check your connection and refresh.')}</p>
    </div>`;
  }
}
boot();
