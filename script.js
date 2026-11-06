
const SUPABASE_URL = 'https://nfdrezutavvxhmblsqdk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FQmEnU0iXInf1Q8lvmMunw_o5UacvKM';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const MAXLISTS = 3;
const AVG = 720;
const CLAIM = 90;
const ADMIN_EMAIL = 'adminchris@example.com';

let E = [];
let RAW = { eq: [], wl: [], se: [] };
let busy = false;

const GROUPS = [
  'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Cardio'
];

const S = {
  screen: 'login',
  stack: [],
  me: null,
  checked: true,
  speed: 1,
  warp: 0,
  group: null,
  q: '',
  sel: null,
  claim: null,
  mins: 12,
  msg: '',
  mode: 'login',
  ok: false,
  email: '',
  name: '',
  gym: null,
  gymChoice: null,
  gymDistances: null,
  gymMessage: ''
};

const $ = selector => document.querySelector(selector);
const app = $('#screen');


const spotNotifications = [];
const notifiedTurns = new Set();

function checkWaitlistNotifications() {
  if (!S.me) return;

  for (const e of E) {
    const first = e.rows?.[0];

    if (
      !first ||
      first.user_id !== S.me ||
      !first.notified_at ||
      e.claimLeft <= 0
    ) continue;

    const key = String(first.waitlist_id);

    if (notifiedTurns.has(key)) continue;

    notifiedTurns.add(key);

    spotNotifications.unshift({
      id: key,
      title: "It's your turn!",
      message: e.name + " is ready. You have 90 seconds to claim it.",
      equipment_id: e.id,
      read: false
    });

    toast(e.name + " is ready! Check your notifications.");
  }

  renderSpotNotifications();
}

function renderSpotNotifications() {
  const count = $('#notification-count');
  const items = $('#notification-items');
  const panel = $('#notification-panel');

  if (!count || !items || !panel) return;

  const unread = spotNotifications.filter(n => !n.read).length;

  count.hidden = unread === 0;
  count.textContent = unread > 9 ? '9+' : String(unread);

  const empty = panel.querySelector('.hint');
  if (empty) empty.hidden = spotNotifications.length > 0;

  items.replaceChildren();

  for (const n of spotNotifications) {
    const item = document.createElement('div');
    item.className = 'spot-notification-item';

    const title = document.createElement('strong');
    title.textContent = n.title;

    const message = document.createElement('p');
    message.textContent = n.message;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'View equipment';

    button.addEventListener('click', () => {
      n.read = true;
      panel.hidden = true;
      $('#notification-toggle')?.setAttribute('aria-expanded', 'false');

      const equipment = E.find(e => e.id === n.equipment_id);

      if (equipment?.status === 'reserved' &&
          equipment.rows?.[0]?.user_id === S.me &&
          equipment.claimLeft > 0) {
        S.claim = n.equipment_id;
        S.screen = 'claim';
      } else {
        toast('This equipment is no longer reserved for you.');
      }

      renderSpotNotifications();
      view();
    });

    item.append(title, message, button);
    items.append(item);
  }
}


try {
  S.warp = Number(localStorage.getItem('spotWarp')) || 0;
} catch (error) {}

// ========================================
// GYM LOCATIONS
// Fictional gyms with approximate city-center
// coordinates for class project testing.
// ========================================

// ========================================
// GYM LOCATIONS - DATABASE
// ========================================

let GYM_LOCATIONS = []; // Changed from const to let for dynamic loading

async function loadGymLocations() {
  const { data, error } = await db
    .from('gym_locations')
    .select('*')
    .order('name');

  if (error) {
    console.error('Error loading gym locations:', error);
    toast('Failed to load gym locations');
    return;
  }

  if (data && data.length) {
    GYM_LOCATIONS = data;
    console.log('Loaded', GYM_LOCATIONS.length, 'gym locations from database');
  } else {
    // Fallback to empty array if no data
    GYM_LOCATIONS = [];
    toast('No gym locations found in database');
  }
}


function distanceMiles(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) *
    Math.cos(lat2 * r) *
    Math.sin(dLng / 2) ** 2;

  return 3958.8 * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

function gymOptions() {
  const gyms = GYM_LOCATIONS.map(g => ({
    ...g,
    distance: S.gymDistances?.[g.id] ?? null
  }));

  if (S.gymDistances) {
    gyms.sort((a, b) => a.distance - b.distance);
  } else {
    gyms.sort((a, b) => a.name.localeCompare(b.name));
  }

  return gyms;
}

function resetGym() {
  S.gym = null;
  S.gymChoice = null;
  S.gymDistances = null;
  S.gymMessage = '';
}

function gymHeader() {
  const header = $('#selected-gym');
  const name = $('#selected-gym-name');

  if (!header || !name) return;

  header.hidden =
    !S.gym ||
    S.screen === 'login' ||
    S.screen === 'gym-select';

  name.textContent = S.gym?.name || '';
}

function findNearbyGyms() {
  if (!navigator.geolocation) {
    S.gymMessage =
      'Location is not supported. Choose a gym manually.';
    render();
    return;
  }

  S.gymMessage = 'Finding your location...';
  render();

  navigator.geolocation.getCurrentPosition(
    position => {
      if (!S.me || S.screen !== 'gym-select') return;

      const { latitude, longitude } = position.coords;

      S.gymDistances = Object.fromEntries(
        GYM_LOCATIONS.map(g => [
          g.id,
          distanceMiles(latitude, longitude, g.lat, g.lng)
        ])
      );

      S.gymMessage =
        'Gyms sorted from closest to farthest (straight-line miles).';

      render();
    },
    () => {
      if (S.screen !== 'gym-select') return;

      S.gymDistances = null;
      S.gymMessage =
        'Location unavailable. Choose a gym manually.';

      render();
    },
    {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 60000
    }
  );
}

// ========================================
// THEME
// ========================================

let currentTheme = 'light';

try {
  currentTheme =
    localStorage.getItem('spotTheme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light');
} catch (error) {}

function applyTheme() {
  document.documentElement.setAttribute(
    'data-theme',
    currentTheme
  );

  const button = $('#theme-toggle');

  if (button) {
    button.textContent =
      currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode';

    button.setAttribute(
      'aria-label',
      currentTheme === 'dark'
        ? 'Switch to light mode'
        : 'Switch to dark mode'
    );
  }
}

applyTheme();

// ========================================
// HELPERS
// ========================================

const vnow = () => Date.now() + S.warp;
const iso = time => new Date(time).toISOString();

const fmt = seconds => {
  seconds = Math.max(0, Math.ceil(seconds));
  return Math.floor(seconds / 60) + ':' +
    String(seconds % 60).padStart(2, '0');
};

const get = id => E.find(e => e.id === id);

const mine = () => E.filter(e => e.queue.includes('You'));

const using = () =>
  E.find(e => e.status === 'inuse' && e.by === 'You');

const wait = e => Math.ceil(
  (
    (e.status === 'inuse'
      ? e.rem
      : e.status === 'reserved'
        ? e.claimLeft
        : 0) +
    e.queue.length * AVG
  ) / 60
);

const LABEL = {
  available: 'Available',
  inuse: 'In use',
  reserved: 'Reserved',
  unavailable: 'Unavailable'
};

function toast(message) {
  const el = $('#toast');
  if (!el) return;

  el.textContent = message;
  el.hidden = false;

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

function go(screen, push = true) {
  if (push && S.screen !== 'login') {
    S.stack.push(S.screen);
  } else if (push) {
    S.stack = [];
  }

  S.screen = screen;
  S.msg = '';

  render();
  window.scrollTo(0, 0);
}

function sub(e) {
  if (e.status === 'available') return 'Ready to use';

  if (e.status === 'inuse') {
    return `${fmt(e.rem)} left · ${e.queue.length} waiting`;
  }

  if (e.status === 'reserved') {
    return `Held for next person · ${e.queue.length} waiting`;
  }

  return 'Out of service';
}

function tile(e) {
  return `
    <button class="tile s-${e.status}"
            data-a="open"
            data-id="${e.id}">
      <b>${e.name}</b>
      <span class="pill s-${e.status}">
        ${LABEL[e.status]}
      </span>
      <span class="sub">${sub(e)}</span>
    </button>
  `;
}

function mins() {
  return `
    <div class="mins" role="group" aria-label="Session time">
      ${[8, 12, 15].map(m => `
        <button class="chip"
                data-a="mins"
                data-m="${m}"
                aria-pressed="${S.mins === m}">
          ${m} min
        </button>
      `).join('')}
    </div>
  `;
}

function busyMsg() {
  return 'You are already using ' +
    using().name +
    '. Finish that session before starting another.';
}

function banner() {
  if (S.email === ADMIN_EMAIL) {
    return `
      <div class="card now">
        <b>Spot Admin</b>
        <span class="sub"> · Dashboard</span>
      </div>
    `;
  }

  const u = using();

  if (!u || S.screen === 'login' || S.screen === 'gym-select') {
    return '';
  }

  return `
    <div class="card now">
      <b>You are using ${u.name}</b>
      <span class="sub"> · ${fmt(u.rem)} left</span>
      <br>
      <button class="link" data-a="finish" data-id="${u.id}">
        Finish session
      </button>
    </div>
  `;
}

// ========================================
// ADMIN ANALYTICS
// ========================================

let usageStats = [];
let usageStatus = 'loading';
let usageLoadedAt = null;

function equipmentUsageTable() {
  if (usageStatus === 'error') {
    return `
      <div class="card">
        <h3>Equipment Usage</h3>
        <p role="alert">Could not load usage statistics.</p>
      </div>
    `;
  }

  if (usageStatus === 'loading') {
    return `
      <div class="card">
        <h3>Equipment Usage</h3>
        <p>Loading usage statistics...</p>
      </div>
    `;
  }

  const escapeText = value =>
    String(value).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c]);

  const rows = usageStats.map(machine => `
    <tr>
      <td>${escapeText(machine.name)}</td>
      <td>${Number(machine.completed_sessions)}</td>
      <td>${Number(machine.total_minutes_used).toFixed(2)}</td>
      <td>${Number(machine.average_minutes_per_session).toFixed(2)}</td>
    </tr>
  `).join('');

  return `
    <div class="card">
      <h3>Equipment Usage</h3>
      <p class="hint">
        Recorded completed sessions · All time · Durations in minutes
      </p>
      <p class="hint">
        Last loaded:
        ${usageLoadedAt
          ? usageLoadedAt.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            })
          : '—'}
      </p>

      <div style="overflow-x:auto">
        <table style="width:100%;text-align:left;border-spacing:12px">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Times used</th>
              <th>Total minutes</th>
              <th>Average minutes</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4">No equipment found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ========================================
// PAGE TEMPLATES
// ========================================

const V = {

  'gym-select': () => `
    <section class="gym-selection-page">
      <h1>Choose Your Gym</h1>
      <p>Select a location before entering Spot.</p>

      <div class="card gym-location-card">
        <h2>Find nearby gyms</h2>
        <p>
          Location is optional. Allow access to sort the
          demo gyms by distance.
        </p>

        <button type="button"
                class="btn alt"
                data-a="find-nearby">
          📍 Use My Location
        </button>

        <p class="hint" role="status">${S.gymMessage}</p>
      </div>

      <div class="gym-options">
        ${gymOptions().map(g => `
          <button type="button"
                  class="gym-option ${S.gymChoice === g.id ? 'chosen' : ''}"
                  data-a="choose-gym"
                  data-g="${g.id}"
                  aria-pressed="${S.gymChoice === g.id}">

            <span aria-hidden="true">
              ${S.gymChoice === g.id ? '●' : '○'}
            </span>

            <span class="gym-option-details">
              <strong>${g.name}</strong>
              <small>Demo gym location</small>
            </span>

            <span class="gym-distance">
              ${g.distance === null
                ? ''
                : g.distance.toFixed(1) + ' mi'}
            </span>
          </button>
        `).join('')}
      </div>

      <button type="button"
              class="btn"
              data-a="confirm-gym"
              ${!S.gymChoice ? 'disabled' : ''}>
        Confirm Gym &amp; Enter Spot
      </button>
    </section>
  `,

  login: () => {
    const su = S.mode === 'signup';

    return `
      <h1>Skip the guessing.<br>Know the wait.</h1>
      <p>
        ${su
          ? 'Create an account to join waitlists and track your sessions.'
          : 'Log in to see which equipment is free and how long the line is.'}
      </p>

      <form id="lf" class="card">
        <h2>${su ? 'Create account' : 'Log in'}</h2>

        <label for="em">Email</label>
        <input id="em"
               type="email"
               autocomplete="email"
               value="${(S.email || '').replace(/"/g, '&quot;')}"
               required>

        <label for="pw">Password</label>
        <input id="pw"
               type="password"
               autocomplete="${su ? 'new-password' : 'current-password'}"
               required>

        ${su ? `
          <label for="pw2">Confirm password</label>
          <input id="pw2"
                 type="password"
                 autocomplete="new-password"
                 required>
        ` : ''}

        ${S.msg ? `
          <p class="${S.ok ? 'hint' : 'err'}" role="alert">
            ${S.msg}
          </p>
        ` : ''}

        <button class="btn" type="submit">
          ${su ? 'Create account' : 'Log in'}
        </button>

        <p style="margin:14px 0 0">
          ${su ? 'Already have an account?' : 'New here?'}
          <button type="button" class="link" data-a="mode">
            ${su ? 'Log in' : 'Create an account'}
          </button>
        </p>
      </form>
    `;
  },

  admin: () => {
    const stats = E.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    }, {
      available: 0,
      inuse: 0,
      reserved: 0,
      unavailable: 0
    });

    return `
      <h2>Admin Dashboard</h2>

      <div class="card">
        <h3>Equipment Status</h3>
        <div class="stats">
          <div class="stat"><b>${stats.available}</b> Available</div>
          <div class="stat"><b>${stats.inuse}</b> In Use</div>
          <div class="stat"><b>${stats.reserved}</b> Reserved</div>
          <div class="stat"><b>${stats.unavailable}</b> Unavailable</div>
        </div>
      </div>

      <div class="card">
        <h3>Users in Waitlists</h3>
        <div class="stats">
          <div class="stat">
            <b>${E.reduce((a, e) => a + e.queue.length, 0)}</b>
            Total in Lines
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Current Sessions</h3>
        <div class="stats">
          <div class="stat">
            <b>${E.filter(e => e.status === 'inuse').length}</b>
            Active Sessions
          </div>
        </div>
      </div>
    `;
  },

  find: () => `
    <h2>What are you training?</h2>

    <form id="sf" class="card">
      <label for="q">Search equipment</label>

      <div class="search-wrap">
        <input id="q"
               type="search"
               placeholder="Bench press, treadmill…"
               autocomplete="off"
               role="combobox"
               aria-autocomplete="list"
               aria-controls="equipment-suggestions"
               aria-expanded="false">

        <div id="equipment-suggestions"
             class="suggestions"
             role="listbox"
             hidden></div>
      </div>

      <button class="btn" type="submit">Search</button>
    </form>

    <button class="btn alt" data-a="groups">
      Browse by muscle group
    </button>
  `,

  groups: () => `
    <h2>Pick a muscle group</h2>
    <div class="chips">
      ${GROUPS.map(g => `
        <button class="chip"
                data-a="group"
                data-g="${g}"
                aria-pressed="false">
          ${g}
        </button>
      `).join('')}
    </div>
  `,

  map: () => {
    const list = E.filter(e =>
      (!S.group || e.g === S.group) &&
      (!S.q || e.name.toLowerCase().includes(S.q))
    );

    return `
      <h2>
        ${S.group ||
          (S.q ? 'Results for "' + S.q + '"' : 'All equipment')}
      </h2>

      <p class="hint">
        Tap a machine to see its wait.
        You are on ${mine().length} of ${MAXLISTS} waitlists.
      </p>

      ${list.length
        ? `<div class="floor">${list.map(tile).join('')}</div>`
        : '<p>No equipment matches. Try another search or muscle group.</p>'}

      ${mine().length
        ? '<button class="btn alt" data-a="mylists">View my waitlists</button>'
        : ''}
    `;
  },

  detail: () => {
    const e = get(S.sel);

    if (!e) return '<p>Equipment not found.</p>';

    const pos = e.queue.indexOf('You') + 1;
    let action = '';

    if (e.status === 'available') {
      action = `
        <p>Choose your session length, then start.</p>
        ${mins()}
        <button class="btn" data-a="start">Start using</button>
      `;
    } else if (e.by === 'You') {
      action = `
        <p>You are using this machine right now.</p>
        <button class="btn alt"
                data-a="finish"
                data-id="${e.id}">
          Finish session
        </button>
      `;
    } else if (pos) {
      action = `
        <p>You are number ${pos} in line.</p>
        <button class="btn" data-a="mylists">
          See my waitlist
        </button>
      `;
    } else {
      action = `
        <button class="btn" data-a="join">
          Join waitlist
        </button>
      `;
    }

    const alternatives = e.status !== 'available'
      ? E.filter(x =>
          x.g === e.g &&
          x.status === 'available' &&
          x.id !== e.id
        )
      : [];

    return `
      <h2>${e.name}</h2>

      <span class="pill s-${e.status}">
        ${LABEL[e.status]}
      </span>

      <div class="stats">
        <div class="stat">
          <b>
            ${e.status === 'unavailable'
              ? '–'
              : e.status === 'available'
                ? '0 min'
                : '~' + wait(e) + ' min'}
          </b>
          Estimated wait
        </div>

        <div class="stat">
          <b>${e.queue.length}</b>
          Waiting
        </div>
      </div>

      ${e.status === 'inuse'
        ? `<p>Session ends in ${fmt(e.rem)}.</p>`
        : ''}

      ${e.status === 'unavailable'
        ? '<p>This equipment is out of service.</p>'
        : ''}

      ${action}

      ${S.msg
        ? `<p class="err" role="alert">${S.msg}</p>`
        : ''}

      ${alternatives.length ? `
        <h3 style="margin-top:22px">
          Free right now, same muscle group
        </h3>
        <div class="floor">
          ${alternatives.map(tile).join('')}
        </div>
      ` : ''}
    `;
  },

  mylists: () => {
    const list = mine();

    return `
      <h2>My waitlists</h2>

      ${list.length
        ? list.map(e => {
            const pos = e.queue.indexOf('You') + 1;
            const estimate = Math.max(
              0,
              Math.ceil(
                wait(e) -
                (e.queue.length - pos) * AVG / 60
              )
            );

            return `
              <div class="card">
                <h3>${e.name}</h3>

                <div class="stats">
                  <div class="stat">
                    <b>#${pos}</b>
                    Your position
                  </div>

                  <div class="stat">
                    <b>~${estimate} min</b>
                    Estimated wait
                  </div>
                </div>

                <p class="hint">
                  ${e.status === 'reserved'
                    ? 'Held for the next person in line.'
                    : fmt(e.rem || 0) +
                      ' left on the current session.'}
                </p>

                <button class="btn danger"
                        data-a="cancel"
                        data-id="${e.id}">
                  Cancel my spot
                </button>
              </div>
            `;
          }).join('')
        : '<p>You are not on any waitlist. Find equipment to join one.</p>'}

      <button class="btn alt" data-a="find">
        Find more equipment
      </button>
    `;
  },

  claim: () => {
    const e = get(S.claim);
    if (!e) return '<p>No equipment to claim.</p>';

    return `
      <div class="card claim-card">
        <h2>${e.name} is ready</h2>

        <p>
          Claim it before the timer runs out,
          or the next person gets it.
        </p>

        <div class="big" aria-live="off">
          ${fmt(e.claimLeft)}
        </div>

        <p>How long will you use it?</p>

        ${mins()}

        ${S.msg
          ? `<p class="err" role="alert">${S.msg}</p>`
          : ''}

        <button class="btn" data-a="claim">
          Claim equipment
        </button>

        <button class="btn danger"
                data-a="cancel"
                data-id="${e.id}">
          Give up my spot
        </button>
      </div>
    `;
  }
};

// ========================================
// DATABASE
// ========================================

function derive() {
  const now = vnow();

  E = RAW.eq.map(q => {
    const rows = RAW.wl
      .filter(w => w.equipment_id === q.equipment_id)
      .sort((a, b) => a.position - b.position);

    const session = RAW.se.find(x =>
      x.equipment_id === q.equipment_id &&
      (!x.end_time || Date.parse(x.end_time) > now)
    );

    const e = {
      id: q.equipment_id,
      name: q.name,
      g: q.muscle_group,
      rows,
      sess: session,
      queue: rows.map(w =>
        w.user_id === S.me ? 'You' : 'Other'
      )
    };

    if (q.status === 'unavailable') {
      e.status = 'unavailable';
    } else if (session) {
      e.status = 'inuse';
      e.rem =
        session.duration_minutes * 60 -
        (now - Date.parse(session.start_time)) / 1000;
      e.by = session.user_id === S.me ? 'You' : null;
    } else if (rows.length) {
      e.status = 'reserved';
      e.claimLeft = rows[0].notified_at
        ? CLAIM -
          (now - Date.parse(rows[0].notified_at)) / 1000
        : CLAIM;
    } else {
      e.status = 'available';
    }

    return e;
  });
}

async function load() {
  const [a, b, c] = await Promise.all([
    db.from('equipment').select('*').order('equipment_id'),
    db.from('waitlist').select('*').order('position'),
    db.from('equipment_session').select('*')
  ]);

  const error = a.error || b.error || c.error;

  if (error) {
    toast('Database error: ' + error.message);
    return false;
  }

  RAW = {
    eq: a.data || [],
    wl: b.data || [],
    se: c.data || []
  };

  return true;
}

async function loadUsageStats() {
  usageStatus = 'loading';

  try {
    const result = await db
      .from('equipment_usage_stats')
      .select('*')
      .order('completed_sessions', { ascending: false })
      .order('name');

    if (result.error) throw result.error;

    usageStats = result.data || [];
    usageStatus = 'ready';
    usageLoadedAt = new Date();
  } catch (error) {
    usageStatus = 'error';
    console.error('Usage statistics failed:', error);
  }

  if (S.screen === 'admin') render();
}

async function compact(eid) {
  const { data, error } = await db
    .from('waitlist')
    .select('waitlist_id,position')
    .eq('equipment_id', eid)
    .order('position');

  if (error) return;

  await Promise.all(
    (data || []).map((row, i) =>
      row.position === i + 1
        ? Promise.resolve()
        : db.from('waitlist')
            .update({
              position: i + 1,
              notified_at: null
            })
            .eq('waitlist_id', row.waitlist_id)
    )
  );
}

async function maintain() {
  if (busy) return;

  busy = true;
  let changed = false;

  try {
    for (const e of E) {
      if (e.sess && e.rem <= 0) {
        await db.from('equipment_session')
          .update({
            end_time: iso(
              Date.parse(e.sess.start_time) +
              e.sess.duration_minutes * 60000
            )
          })
          .eq('session_id', e.sess.session_id);

        if (e.by === 'You') {
          toast('Your session on ' + e.name + ' has ended.');
        }

        changed = true;
      } else if (!e.sess && e.status === 'reserved') {
        const first = e.rows[0];

        if (!first.notified_at) {
          await db.from('waitlist')
            .update({ notified_at: iso(vnow()) })
            .eq('waitlist_id', first.waitlist_id);

          changed = true;
        } else if (e.claimLeft <= 0) {
          await db.from('waitlist')
            .delete()
            .eq('waitlist_id', first.waitlist_id);

          await compact(e.id);

          if (first.user_id === S.me) {
            toast(
              'Time ran out. Your spot on ' +
              e.name +
              ' was removed.'
            );
          }

          changed = true;
        }
      }
    }

    if (changed) {
      await load();
      derive();
    }
  } finally {
    busy = false;
  }
}

async function sync() {
  if (!S.me) return;

  if (await load()) {
    derive();
    await maintain();
    checkWaitlistNotifications();
  }

  view();
}

function view() {
  if (S.screen === 'gym-select') return;

  const turn = E.find(e =>
    e.status === 'reserved' &&
    e.queue[0] === 'You'
  );

  
if (
  turn &&
  !S.claim &&
  S.screen !== 'login'
) {
  S.claim = turn.id;

  if (S.screen !== 'claim') {
    S.stack.push(S.screen);
    S.screen = 'claim';
    toast(turn.name + ' is ready. Claim it now.');
  }
} else if (!turn && S.claim) {
  S.claim = null;

  if (S.screen === 'claim') {
    S.screen = 'map';
    S.stack = ['find'];
    S.msg = '';
  }
}


  
if (S.screen === 'claim' && app.querySelector('.claim-card')) {
  const timer = app.querySelector('.claim-card .big');
  const equipment = get(S.claim);

  if (timer && equipment) {
    timer.textContent = fmt(equipment.claimLeft);
  }

  return;
}

if (!['find', 'groups', 'login'].includes(S.screen)) {
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

}

// ========================================
// RENDER
// ========================================

function render() {
  if (!app || !V[S.screen]) return;

  const focused = document.activeElement;
  const inApp = focused && app.contains(focused);

  const focusKey = el => el
    ? [
        el.id,
        el.dataset.a,
        el.dataset.id,
        el.dataset.m,
        el.dataset.g
      ].join('|')
    : '';

  const key = inApp ? focusKey(focused) : '';

  app.innerHTML =
    banner() +
    V[S.screen]() +
    (S.screen === 'admin' ? equipmentUsageTable() : '');

  gymHeader();

  if (inApp && key) {
    const match = [...app.querySelectorAll(focused.tagName)]
      .find(el => focusKey(el) === key);

    if (match) match.focus({ preventScroll: true });
  }

  const back = $('#back');

  if (back) {
    back.hidden =
      !S.stack.length ||
      S.screen === 'gym-select';
  }

const notificationWrap = $('#notification-wrap');

if (notificationWrap) {
  notificationWrap.hidden =
    !S.me ||
    S.screen === 'login' ||
    S.screen === 'gym-select';
}

  const menuToggle = $('#menu-toggle');
  const menu = $('#spot-menu');

  if (menuToggle) {
    menuToggle.hidden =
      S.screen === 'login' ||
      S.screen === 'gym-select';
  }

  if (
    menu &&
    menuToggle &&
    (S.screen === 'login' || S.screen === 'gym-select')
  ) {
    menu.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
  }

  const menuName = $('#menu-name');
  const menuAvatar = $('#menu-avatar');

  if (menuName) menuName.textContent = S.name || 'My Account';

  if (menuAvatar) {
    menuAvatar.textContent =
      (S.name || '?').charAt(0).toUpperCase();
  }

  const brand = $('#brand') || $('.brand');

  if (brand) {
    brand.textContent =
      S.email === ADMIN_EMAIL ? 'Spot Admin' : 'Spot';
  }
}

// ========================================
// LOGIN
// ========================================

async function enter(id) {
  try {
    localStorage.setItem('spotUser', String(id));
  } catch (error) {}

  await db.from('users')
    .update({ checked_in: true })
    .eq('user_id', id);

  await db.rpc('close_stale_check_ins');

  const openRow = await db.from('check_ins')
    .select('check_in_id')
    .eq('user_id', id)
    .is('checked_out_at', null)
    .limit(1);

  if (!openRow.data || !openRow.data.length) {
    await db.from('check_ins').insert({ user_id: id });
  }

  const user = await db.from('users')
    .select('email')
    .eq('user_id', id)
    .maybeSingle();

  S.name = user.data?.email
    ? user.data.email.split('@')[0]
    : '';

  S.me = id;
  S.checked = true;
  S.msg = '';
  S.email = user.data?.email || '';

  await load();
  derive();
  resetGym();

  S.screen = S.email === ADMIN_EMAIL
    ? 'admin'
    : 'gym-select';

  S.stack = [];

  render();

  if (S.screen === 'admin') {
    loadUsageStats();
  }
}

document.addEventListener('submit', async ev => {
  ev.preventDefault();

  if (ev.target.id === 'lf') {
    const email = $('#em').value.trim();
    const password = $('#pw').value;
    const signup = S.mode === 'signup';

    S.email = email;
    S.ok = false;

    if (signup && password !== $('#pw2').value) {
      S.msg = 'Passwords do not match.';
      render();
      return;
    }

    let id;

    if (signup) {
      const result = await db.from('users')
        .insert({ email, password })
        .select('user_id')
        .single();

      if (result.error) {
        S.msg = result.error.code === '23505'
          ? 'That email already has an account.'
          : result.error.message;
        render();
        return;
      }

      id = result.data.user_id;
    } else {
      const result = await db.from('users')
        .select('user_id')
        .eq('email', email)
        .eq('password', password)
        .maybeSingle();

      if (result.error) {
        S.msg = result.error.message;
        render();
        return;
      }

      if (!result.data) {
        S.msg =
          'We could not log you in. Check your email and password.';
        render();
        return;
      }

      id = result.data.user_id;
    }

    await enter(id);
  }

  if (ev.target.id === 'sf') {
    S.q = $('#q').value.trim().toLowerCase();
    S.group = null;
    go('map');
  }
});

// ========================================
// SEARCH AUTOCOMPLETE
// ========================================

let suggestionIndex = -1;

function getEquipmentSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const names = [
    ...new Set(E.map(e => e.name).filter(Boolean))
  ];

  return names
    .filter(name => name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(q);
      const bStarts = b.toLowerCase().startsWith(q);

      if (aStarts !== bStarts) {
        return aStarts ? -1 : 1;
      }

      return a.localeCompare(b);
    })
    .slice(0, 5);
}

function updateEquipmentSuggestions() {
  const input = $('#q');
  const box = $('#equipment-suggestions');

  if (!input || !box) return;

  const matches = getEquipmentSuggestions(input.value);

  suggestionIndex = -1;
  box.replaceChildren();

  matches.forEach((name, index) => {
    const option = document.createElement('button');

    option.type = 'button';
    option.className = 'suggestion';
    option.id = `equipment-suggestion-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.textContent = name;

    option.addEventListener('click', () => {
      input.value = name;
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');

      S.q = name.toLowerCase();
      S.group = null;

      go('map');
    });

    box.appendChild(option);
  });

  box.hidden = matches.length === 0;
  input.setAttribute(
    'aria-expanded',
    String(matches.length > 0)
  );
  input.removeAttribute('aria-activedescendant');
}

document.addEventListener('input', ev => {
  if (ev.target.id === 'q') {
    updateEquipmentSuggestions();
  }
});

document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    const modal = $('#modal');
    if (modal) modal.hidden = true;
  }

  if (ev.target.id !== 'q') return;

  const box = $('#equipment-suggestions');
  if (!box || box.hidden) return;

  const options = [...box.querySelectorAll('.suggestion')];
  if (!options.length) return;

  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    suggestionIndex =
      (suggestionIndex + 1) % options.length;
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    suggestionIndex =
      (suggestionIndex - 1 + options.length) %
      options.length;
  } else if (ev.key === 'Enter' && suggestionIndex >= 0) {
    ev.preventDefault();
    options[suggestionIndex].click();
    return;
  } else if (ev.key === 'Escape') {
    box.hidden = true;
    ev.target.setAttribute('aria-expanded', 'false');
    return;
  } else {
    return;
  }

  options.forEach((option, index) => {
    const active = index === suggestionIndex;

    option.classList.toggle('active', active);
    option.setAttribute(
      'aria-selected',
      String(active)
    );

    if (active) {
      ev.target.setAttribute(
        'aria-activedescendant',
        option.id
      );
    }
  });
});

// ========================================
// BUTTON ACTIONS
// ========================================

const myRow = e =>
  e.rows.find(w => w.user_id === S.me);

document.addEventListener('click', async ev => {
  const b = ev.target.closest('button');
  if (!b) return;


if (b.id === 'notification-toggle') {
  const panel = $('#notification-panel');

  if (!panel) return;

  panel.hidden = !panel.hidden;

  b.setAttribute(
    'aria-expanded',
    String(!panel.hidden)
  );

  return;
}


  if (b.id === 'menu-toggle') {
    const menu = $('#spot-menu');
    if (!menu) return;

    menu.hidden = !menu.hidden;

    b.setAttribute(
      'aria-expanded',
      String(!menu.hidden)
    );
    return;
  }

  if (b.closest('#spot-menu')) {
    const menu = $('#spot-menu');
    if (menu) menu.hidden = true;

    const toggle = $('#menu-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  if (b.id === 'profile-open') {
    toast('Profile settings are coming next.');
    return;
  }

  if (b.id === 'theme-toggle') {
    currentTheme =
      currentTheme === 'light' ? 'dark' : 'light';

    applyTheme();

    try {
      localStorage.setItem('spotTheme', currentTheme);
    } catch (error) {}

    return;
  }

  if (b.id === 'back') {
    if (!S.stack.length) return;

    S.screen = S.stack.pop();
    S.msg = '';
    render();
    return;
  }

  if (b.id === 'checkin') {
    $('#modal').hidden = false;
    $('#co-no').focus();
    return;
  }

  if (b.id === 'co-no') {
    $('#modal').hidden = true;
    return;
  }

  if (b.id === 'co-yes') {
    $('#modal').hidden = true;

    for (const x of E) {
      const row = myRow(x);

      if (row) {
        await db.from('waitlist')
          .delete()
          .eq('waitlist_id', row.waitlist_id);

        await compact(x.id);
      }
    }

    const u = using();

    if (u) {
      await db.from('equipment_session')
        .update({ end_time: iso(vnow()) })
        .eq('session_id', u.sess.session_id);
    }

    await db.from('users')
      .update({ checked_in: false })
      .eq('user_id', S.me);

    await db.from('check_ins')
      .update({ checked_out_at: new Date().toISOString() })
      .eq('user_id', S.me)
      .is('checked_out_at', null);

    try {
      localStorage.removeItem('spotUser');
      localStorage.removeItem('spotView');
    } catch (error) {}

    S.me = null;
    S.name = '';
    S.email = '';
    S.claim = null;
    S.screen = 'login';
    S.stack = [];
    S.group = null;
    S.q = '';
    E = [];

    resetGym();

    toast('You have been checked out.');
    render();
    return;
  }

  if (b.id === 'speed') {
    S.speed = S.speed === 1 ? 30 : 1;

    b.setAttribute(
      'aria-pressed',
      String(S.speed > 1)
    );

    b.textContent =
      S.speed > 1
        ? '30x Time: On'
        : '30x Time: Off';

    return;
  }

  const a = b.dataset.a;
  const e = b.dataset.id
    ? get(Number(b.dataset.id))
    : null;

  if (!a) return;

  // GYM SELECTION ACTIONS

  if (a === 'find-nearby' && S.screen === 'gym-select') {
    findNearbyGyms();
    return;
  }

  if (a === 'choose-gym' && S.screen === 'gym-select') {
    S.gymChoice = b.dataset.g;
    render();
    return;
  }

  if (
    a === 'confirm-gym' &&
    S.screen === 'gym-select' &&
    !S.gym
  ) {
    const gym = GYM_LOCATIONS.find(
      g => g.id === S.gymChoice
    );

    if (!gym) return;

    S.gym = gym;
    S.screen = 'find';
    S.stack = [];
    S.msg = '';

    saveView();
    render();
    return;
  }

  // EXISTING SPOT ACTIONS

  if (a === 'mode') {
    S.mode =
      S.mode === 'login' ? 'signup' : 'login';

    S.msg = '';
    S.ok = false;
    render();
    return;
  }

  if (a === 'groups') {
    go('groups');
    return;
  }

  if (a === 'group') {
    S.group = b.dataset.g;
    S.q = '';
    go('map');
    return;
  }

  if (a === 'open' && e) {
    S.sel = e.id;
    go('detail');
    return;
  }

  if (a === 'mins') {
    S.mins = Number(b.dataset.m);
    render();
    return;
  }

  if (a === 'find') {
    S.stack = [];
    S.q = '';
    S.group = null;
    go('find', false);
    return;
  }

  if (a === 'mylists') {
    go('mylists');
    return;
  }

  if (a === 'start') {
    if (using()) {
      S.msg = busyMsg();
    } else {
      const { error } = await db
        .from('equipment_session')
        .insert({
          user_id: S.me,
          equipment_id: S.sel,
          duration_minutes: S.mins,
          start_time: iso(vnow())
        });

      if (error) {
        S.msg = error.code === '23505'
          ? 'Someone just started on this machine, or you already have a session open.'
          : error.message;
      } else {
        toast('Enjoy your set. Your session timer has started.');
      }
    }

    await sync();
    render();
    return;
  }

  if (a === 'finish' && e?.sess) {
    await db.from('equipment_session')
      .update({ end_time: iso(vnow()) })
      .eq('session_id', e.sess.session_id);

    toast('Session finished.');
    await sync();
    render();
    return;
  }

  if (a === 'join') {
    const x = get(S.sel);
    if (!x) return;

    if (x.by === 'You') {
      S.msg =
        'You are using this machine right now, so you cannot join its waitlist.';
    } else if (!S.checked) {
      S.msg =
        'You need to check in at the gym before joining a waitlist.';
    } else if (x.status === 'unavailable') {
      S.msg =
        'This equipment is unavailable.';
    } else if (mine().length >= MAXLISTS) {
      S.msg =
        'You are on 3 waitlists already. Cancel one first.';
    } else {
      const { error } = await db
        .from('waitlist')
        .insert({
          user_id: S.me,
          equipment_id: x.id,
          position: x.rows.length + 1
        });

      if (error) {
        S.msg = error.code === '23505'
          ? 'You are already on this waitlist.'
          : error.message;
      } else {
        await sync();
        go('mylists');
        return;
      }
    }

    render();
    return;
  }

  if (a === 'cancel' && e) {
    const row = myRow(e);

    if (row) {
      await db.from('waitlist')
        .delete()
        .eq('waitlist_id', row.waitlist_id);

      await compact(e.id);
    }

    toast('Removed from the ' + e.name + ' waitlist.');

    if (S.screen === 'claim') {
      S.screen = 'map';
      S.stack = ['find'];
      S.claim = null;
    }

    await sync();
    render();
    return;
  }

  if (a === 'claim') {
    if (using()) {
      S.msg = busyMsg();
      render();
      return;
    }

    const c = get(S.claim);
    if (!c || !c.rows.length) return;

    const row = c.rows[0];

    const { error } = await db
      .from('equipment_session')
      .insert({
        user_id: S.me,
        equipment_id: c.id,
        duration_minutes: S.mins,
        start_time: iso(vnow())
      });

    if (error) {
      S.msg = error.code === '23505'
        ? 'Someone else started on this machine first.'
        : error.message;

      render();
      return;
    }

    await db.from('waitlist')
      .delete()
      .eq('waitlist_id', row.waitlist_id);

    await compact(c.id);

    S.claim = null;
    S.sel = c.id;
    S.stack = ['find', 'map'];
    S.screen = 'detail';
    S.msg = '';

    toast('It is yours. Your session timer has started.');

    await sync();
    render();
    return;
  }
});

// Close dropdowns when clicking outside

document.addEventListener('click', ev => {
  if (!ev.target.closest('.menu-wrap')) {
    const menu = $('#spot-menu');
    const toggle = $('#menu-toggle');

    if (menu) menu.hidden = true;

    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  if (!ev.target.closest('.search-wrap')) {
    const box = $('#equipment-suggestions');
    if (box) box.hidden = true;
  }
});

// ========================================
// TIMERS AND SYNC
// ========================================

setInterval(() => {
  if (!S.me) return;

  S.warp += (S.speed - 1) * 1000;

  try {
    localStorage.setItem('spotWarp', S.warp);
  } catch (error) {}

  derive();
  view();
}, 1000);


let syncRunning = false;

async function fastSync() {
  if (!S.me || syncRunning || document.hidden) return;

  syncRunning = true;

  try {
    await sync();
  } catch (error) {
    console.error('Spot sync error:', error);
  } finally {
    syncRunning = false;
  }
}

setInterval(fastSync, 1000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) fastSync();
});


setInterval(() => {
  if (S.me) {
    db.rpc('heartbeat', { p_user: S.me });
  }
}, 20000);

// ========================================
// AUTO LOGOUT
// ========================================

const IDLE_MS = 30 * 60 * 1000;

let lastTouch = Date.now();
let lastSave = 0;

[
  'click',
  'keydown',
  'touchstart',
  'mousemove',
  'scroll'
].forEach(eventName => {
  document.addEventListener(eventName, () => {
    lastTouch = Date.now();

    if (lastTouch - lastSave > 10000) {
      lastSave = lastTouch;

      try {
        localStorage.setItem(
          'spotSeen',
          String(lastTouch)
        );
      } catch (error) {}
    }
  }, { passive: true });
});

setInterval(async () => {
  if (
    !S.me ||
    Date.now() - lastTouch < IDLE_MS ||
    using() ||
    mine().length
  ) {
    return;
  }

  const id = S.me;
  S.me = null;

  await db.from('users')
    .update({ checked_in: false })
    .eq('user_id', id);

  await db.from('check_ins')
    .update({
      checked_out_at: new Date().toISOString()
    })
    .eq('user_id', id)
    .is('checked_out_at', null);

  try {
    localStorage.removeItem('spotUser');
    localStorage.removeItem('spotView');
  } catch (error) {}

  S.name = '';
  S.email = '';
  S.claim = null;
  S.screen = 'login';
  S.stack = [];
  S.group = null;
  S.q = '';
  S.ok = true;

  E = [];
  resetGym();

  S.msg =
    'You were logged out after ' +
    Math.round(IDLE_MS / 60000) +
    ' minutes of inactivity. Log in to continue.';

  render();
}, 30000);

// ========================================
// REMEMBER GYM AFTER REFRESH
// ========================================

function saveView() {
  if (
    !S.me ||
    S.screen === 'login' ||
    S.screen === 'claim'
  ) {
    return;
  }

  try {
    localStorage.setItem(
      'spotView',
      JSON.stringify({
        u: S.me,
        screen: S.screen,
        stack: S.stack,
        sel: S.sel,
        group: S.group,
        q: S.q,
        gymId: S.gym?.id || null
      })
    );
  } catch (error) {}
}

function restoreView() {
  let saved = null;

  try {
    saved = JSON.parse(
      localStorage.getItem('spotView') || 'null'
    );
  } catch (error) {}

  if (!saved || saved.u !== S.me) return;

  // FIX: Check if GYM_LOCATIONS has data before trying to find gym
  if (!GYM_LOCATIONS || GYM_LOCATIONS.length === 0) {
    console.warn('No gym locations loaded, skipping restoreView');
    return;
  }

  const gym = GYM_LOCATIONS.find(
    g => g.id === saved.gymId
  );

  if (!gym) return;

  S.gym = gym;
  S.gymChoice = gym.id;

  const allowed = [
    'find',
    'groups',
    'map',
    'detail',
    'mylists'
  ];

  if (!allowed.includes(saved.screen)) {
    S.screen = 'find';
    render();
    return;
  }

  if (saved.screen === 'detail' && !get(saved.sel)) {
    S.screen = 'find';
    render();
    return;
  }

  S.screen = saved.screen;
  S.stack = Array.isArray(saved.stack)
    ? saved.stack.filter(s =>
        allowed.includes(s)
      )
    : [];

  S.sel = saved.sel;
  S.group = saved.group;
  S.q = saved.q || '';

  render();
}


window.addEventListener('pagehide', saveView);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveView();
  }
});

// ========================================
// INITIALIZE APPLICATION
// ========================================

render();

// ========================================
// INITIALIZE APPLICATION
// ========================================

render();  // Render login screen initially

(async () => {
  // Load gym locations with error handling
  try {
    await loadGymLocations();
    console.log('Gym locations loaded successfully');
  } catch (error) {
    console.error('Failed to load gym locations:', error);
    toast('Failed to load gym locations');
    // Continue anyway - app will use default view
  }

  // Check for saved user session
  let savedUser = null;

  try {
    savedUser = localStorage.getItem('spotUser');
  } catch (error) {}

  if (!savedUser) return;

  try {
    savedUser = localStorage.getItem('spotUser');
  } catch (error) {}

  if (!savedUser) return;

  let lastSeen = 0;

  try {
    lastSeen = Number(localStorage.getItem('spotSeen')) || 0;
  } catch (error) {}

  // Handle idle timeout
  if (lastSeen && Date.now() - lastSeen > IDLE_MS) {
    try {
      localStorage.removeItem('spotUser');
      localStorage.removeItem('spotView');
    } catch (error) {}
    return;
  }

  // Verify user exists and restore session
  const { data, error } = await db
    .from('users')
    .select('user_id')
    .eq('user_id', savedUser)
    .maybeSingle();

  if (error) {
    console.error('Could not restore login:', error.message);
    return;
  }

  if (data) {
    await enter(data.user_id);
    
    // Now restore view after gym locations are loaded
    restoreView();
  } else {
    try {
      localStorage.removeItem('spotUser');
      localStorage.removeItem('spotView');
    } catch (error) {}
  }
})();

