
const SUPABASE_URL = 'https://nfdrezutavvxhmblsqdk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FQmEnU0iXInf1Q8lvmMunw_o5UacvKM';
const spotResetParams = new URLSearchParams(window.location.search);
const spotResetHash = new URLSearchParams(window.location.hash.slice(1));

const spotRecoveryLink =
  spotResetParams.get('spot_reset') === '1' ||
  spotResetParams.get('type') === 'recovery' ||
  spotResetHash.get('type') === 'recovery';

let spotRecoveryConfirmed = false;

function clearSpotResetUrl() {
  const url = new URL(window.location.href);

  url.searchParams.delete('spot_reset');
  url.searchParams.delete('type');
  url.searchParams.delete('code');
  url.searchParams.delete('error');
  url.searchParams.delete('error_code');
  url.searchParams.delete('error_description');

  url.hash = '';

  window.history.replaceState(
    {},
    '',
    url.pathname + url.search
  );
}
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);


async function getSpotUser() {
  const { data: authData, error: authError } =
    await db.auth.getUser();

  if (authError || !authData.user ||
      !authData.user.email_confirmed_at) {
    return null;
  }

  const { data, error } = await db
    .from('users')
    .select('user_id')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();

  if (error) throw error;

  // Link an existing Spot account by verified email.
  if (!data) {
    const { data: existing, error: lookupError } = await db
      .from('users')
      .select('user_id, auth_user_id')
      .eq('email', authData.user.email)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      if (existing.auth_user_id &&
          existing.auth_user_id !== authData.user.id) {
        throw new Error('This Spot account is already linked.');
      }

      const { error: linkError } = await db
        .from('users')
        .update({ auth_user_id: authData.user.id })
        .eq('user_id', existing.user_id)
        .is('auth_user_id', null);

      if (linkError) throw linkError;

      return existing.user_id;
    }

    const { data: created, error: createError } = await db
      .from('users')
      .insert({
        email: authData.user.email,
        password: '',
        auth_user_id: authData.user.id
      })
      .select('user_id')
      .single();

    if (createError) throw createError;

    return created.user_id;
  }

  return data.user_id;
}


const MAXLISTS = 3;
const AVG = 720;
const CLAIM = 90;
const ADMIN_EMAIL = 'adminchris@example.com';

let E = [];
let RAW = { 
  eq: [], 
  wl: [], 
  se: [], 
  gm: []  // Added for gym locations
};

let busy = false;
// Up next state is restored from Supabase, not localStorage.
let upNextState = {
  selection: null,
  interest_counts: [],
  waitlists: []
};

let upNextReady = false;
let spotServerOffset = 0;

function resetUpNextState() {
  upNextState = {
    selection: null,
    interest_counts: [],
    waitlists: []
  };

  upNextReady = false;
  spotServerOffset = 0;
}
let equipmentActionPending = false;
let equipmentSyncPromise = null;

function applyEquipmentState(data) {
  if (!data || !Number.isFinite(Date.parse(data.server_time))) {
    throw new Error('Supabase returned an invalid equipment response.');
  }

  const previous = upNextState.selection;

  upNextState = data;
  spotServerOffset = Date.parse(data.server_time) - Date.now();
  upNextReady = true;

  const converted = previous && data.waitlists?.find(row =>
    row.equipment_id === previous.equipment_id &&
    row.from_up_next
  );

  if (converted) {
    toast(
      previous.equipment_name +
      ' is now a waitlist spot. You are #' +
      converted.position + ' in line.'
    );
  }
}

const spotText = value => String(value ?? '').replace(
  /[&<>"']/g,
  character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]
);

function upNextPanelContents() {
  if (
    !upNextReady ||
    !S.me ||
    ['login', 'gym-select', 'admin'].includes(S.screen)
  ) return '';

  const pending = upNextState.selection;
  let html = '';

  if (pending) {
    html += `
      <div class="card">
        <h3>Up next: ${spotText(pending.equipment_name)}</h3>

        <p>
          This machine is open.
          Other people can still start using it.
        </p>

        ${pending.people_ahead > 0 ? `
          <p class="hint">
            ${pending.people_ahead} earlier Up next
            selection${pending.people_ahead === 1 ? '' : 's'}.
          </p>
        ` : ''}

        <button class="btn alt" data-a="clear-next">
          Clear Up next
        </button>
      </div>
    `;
  }

  for (const equipment of E) {
    const row = equipment.rows.find(item =>
      item.user_id === S.me
    );

    if (!row) continue;

    const ready =
      equipment.status === 'reserved' &&
      equipment.rows[0]?.user_id === S.me &&
      equipment.claimLeft > 0;

    if (!row.from_up_next && !ready) continue;

    let message;

    if (ready) {
      message =
        'Ready now — ' + fmt(equipment.claimLeft) +
        ' left to claim. Forfeit if you want to finish your current workout.';
    } else if (equipment.status === 'inuse') {
      message =
        'Current session ends in ' + fmt(equipment.rem) +
        '. It may finish early. Be ready to claim it when it is your turn.';
    } else {
      message =
        'Waiting for the person ahead of you to claim or forfeit.';
    }

    html += `
      <div class="card">
        <h3>
          ${ready ? 'Your turn' : 'Queued next'}:
          ${spotText(equipment.name)}
        </h3>

        <p>
          You are #${row.position} in line.
          ${spotText(message)}
        </p>

        ${ready ? `
          <button class="btn"
                  data-a="show-claim"
                  data-id="${equipment.id}">
            Choose this machine
          </button>
        ` : ''}

        <button class="btn alt"
                data-a="cancel"
                data-id="${equipment.id}">
          Forfeit this spot
        </button>
      </div>
    `;
  }

  return html;
}

function upNextPanel() {
  return '<div id="spot-up-next">' +
    upNextPanelContents() + '</div>';
}

function updateUpNextPanel() {
  const panel = $('#spot-up-next');
  if (!panel) return;

  const html = upNextPanelContents();
  if (panel.innerHTML === html) return;

  const focused = document.activeElement;
  const action = panel.contains(focused)
    ? focused.dataset.a
    : null;
  const id = action ? focused.dataset.id : null;

  panel.innerHTML = html;

  if (action) {
    [...panel.querySelectorAll('button')].find(button =>
      button.dataset.a === action &&
      button.dataset.id === id
    )?.focus({ preventScroll: true });
  }
}

function updateEquipmentButtons() {
  for (const button of app.querySelectorAll('button[data-a]')) {
    if ([
      'set-next', 'clear-next', 'start', 'finish',
      'join', 'cancel', 'claim'
    ].includes(button.dataset.a)) {
      button.disabled = equipmentActionPending;
    }
  }

  const checkoutButton = $('#co-yes');

  if (checkoutButton) {
    checkoutButton.disabled = equipmentActionPending;
  }
}

async function runEquipmentAction(
  action,
  equipment = null,
  finish = false
) {
  if (equipmentActionPending) return false;

  if (!upNextReady) {
    toast('Use a verified account to access Up next.');
    return false;
  }

  const owner = S.me;
  const minutes = S.mins;

  equipmentActionPending = true;
  S.msg = '';
  updateEquipmentButtons();

  try {
    if (equipmentSyncPromise) await equipmentSyncPromise;
    if (S.me !== owner) return false;

    const { data, error } = await db.rpc('spot_equipment_action', {
      p_action: action,
      p_equipment: equipment,
      p_minutes: minutes,
      p_finish_current: finish
    });

    if (error) throw error;
    if (S.me !== owner) return false;

    applyEquipmentState(data);
    await sync();

    return true;
  } catch (error) {
    if (S.me === owner) {
      S.msg = error.message;
      toast(error.message);
      await sync().catch(console.error);
    }

    return false;
  } finally {
    equipmentActionPending = false;
    if (S.me === owner) render();
  }
}

async function refreshEquipmentState() {
  const owner = S.me;
  if (!owner) return false;

  const { data, error } = await db.rpc('spot_equipment_action', {
  p_action: 'get'
  });

  if (error) throw error;
  if (S.me !== owner) return false;

  applyEquipmentState(data);
  return true;
}

const GROUPS = [
  'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Cardio'
];

const S = {
  screen: 'login',
  avatarUrl: null,
  notificationsEnabled: true,
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
  if (!S.me || !S.notificationsEnabled || !S.gym?.gym_id) return;

  let notificationsChanged = false;

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

    notificationsChanged = true;

    toast(e.name + " is ready! Check your notifications.");
  }

  if (notificationsChanged) {
    renderSpotNotifications();
  }
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

    const timer = document.createElement('strong');
    timer.className = 'notification-claim-timer';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Claim Equipment';

    const equipment = E.find(e => e.id === n.equipment_id);
    const claimable = equipment?.status === 'reserved' &&
      equipment.rows?.[0]?.user_id === S.me &&
      equipment.claimLeft > 0;

    if (n.claimed) {
  timer.textContent = 'Successfully claimed!';
  button.textContent = 'Claimed';
  button.disabled = true;
  n.read = true;
} else if (claimable) {
  timer.textContent = 'Time left: ' + fmt(equipment.claimLeft);
  button.textContent = 'Claim Equipment';
  button.disabled = false;
} else {
  timer.textContent = 'Claim expired';
  button.textContent = 'Claim unavailable';
  button.disabled = true;
}

        button.addEventListener('click', () => {
      const current = E.find(e => e.id === n.equipment_id);

      if (
        !current ||
        current.status !== 'reserved' ||
        current.rows?.[0]?.user_id !== S.me ||
        current.claimLeft <= 0
      ) {
        toast('This equipment is no longer reserved for you.');
        renderSpotNotifications();
        return;
      }

      const existingPicker = item.querySelector('.notification-duration-picker');

      if (existingPicker) {
        existingPicker.remove();
        return;
      }

      const picker = document.createElement('div');
      picker.className = 'notification-duration-picker';

      picker.style.cssText = `
        margin-top: 10px;
        padding: 10px;
        border: 1px solid #8885;
        border-radius: 8px;
      `;

      const label = document.createElement('p');
      label.textContent = 'How long will you use it?';
      label.style.margin = '0 0 8px';

      const choices = document.createElement('div');
      choices.style.cssText = `
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      `;

      [8, 12, 15].forEach(minutes => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'btn';
        choice.textContent = minutes + ' min';

        choice.addEventListener('click', () => {
          const latest = E.find(e => e.id === n.equipment_id);

          if (
            !latest ||
            latest.status !== 'reserved' ||
            latest.rows?.[0]?.user_id !== S.me ||
            latest.claimLeft <= 0
          ) {
            toast('Your claim time has expired.');
            renderSpotNotifications();
            return;
          }

          S.mins = minutes;
          S.claim = latest.id;
          S.screen = 'claim';
          S.msg = '';

          panel.hidden = true;
          $('#notification-toggle')?.setAttribute(
            'aria-expanded', 'false'
          );

          render();

          const claimButton = app.querySelector('[data-a="claim"]');

          if (claimButton) {
            claimButton.click();
          }
        });

        choices.appendChild(choice);
      });

      picker.append(label, choices);
      item.appendChild(picker);
    });

    item.append(title, message, timer, button);
    items.append(item);
  }
}

function updateNotificationClaimTimers() {
    const now = Date.now();

  const expiredClaims = spotNotifications.filter(
    n => n.claimed && n.claimedAt &&
         now - n.claimedAt >= 10000
  );

  if (expiredClaims.length > 0) {
    for (let i = spotNotifications.length - 1; i >= 0; i--) {
      const n = spotNotifications[i];

      if (n.claimed && n.claimedAt &&
          now - n.claimedAt >= 10000) {
        spotNotifications.splice(i, 1);
      }
    }

    renderSpotNotifications();
  }
  const items = document.querySelectorAll('.spot-notification-item');

  spotNotifications.forEach((n, index) => {
    const item = items[index];
    if (!item) return;

    const timer = item.querySelector('.notification-claim-timer');
    const button = item.querySelector('button');
    const equipment = E.find(e => e.id === n.equipment_id);

    if (!timer || !button) return;

    const claimable = equipment?.status === 'reserved' &&
      equipment.rows?.[0]?.user_id === S.me &&
      equipment.claimLeft > 0;

    if (n.claimed) {
  timer.textContent = 'Successfully claimed!';
  button.textContent = 'Claimed';
  button.disabled = true;
  n.read = true;
} else if (claimable) {
  timer.textContent = 'Time left: ' + fmt(equipment.claimLeft);
  button.textContent = 'Claim Equipment';
  button.disabled = false;
} else {
  timer.textContent = 'Claim expired';
  button.textContent = 'Claim unavailable';
  button.disabled = true;
}
    });

  const count = $('#notification-count');
  if (count) {
    const unread = spotNotifications.filter(n => !n.read).length;
    count.hidden = unread === 0;
    count.textContent = unread > 9 ? '9+' : String(unread);
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
    distance: S.gymDistances?.[g.gym_id] ?? null
  }));

  if (S.gymDistances) {
    gyms.sort((a, b) =>
      (a.distance ?? Infinity) - (b.distance ?? Infinity)
    );
  } else {
    gyms.sort((a, b) => a.name.localeCompare(b.name));
  }

  return gyms;
}



function resetGym() {
  S.gym = null;
  S.gymChoice = null;
  S.gymDistances = {};
  S.gymMessage = '';
}

function savedGymKey() {
  return `spotSelectedGym:${S.me}`;
}



function restoreGymChoice() {
  if (!S.me) return;

  try {
    const saved = localStorage.getItem(savedGymKey());

    if (!saved) return;

    const gym = GYM_LOCATIONS.find(
      g => String(g.gym_id) === String(saved)
    );

    S.gymChoice = gym ? gym.gym_id : null;

  } catch (error) {
    S.gymChoice = null;
  }
}


// Check browser permission without showing a new prompt.
async function checkExistingLocationPermission() {
  if (
    S.screen !== 'gym-select' ||
    !navigator.geolocation ||
    !navigator.permissions?.query
  ) return;

  try {
    const status = await navigator.permissions.query({
      name: 'geolocation'
    });

    if (status.state === 'granted' &&
        S.screen === 'gym-select') {
      findNearbyGyms();
    }
  } catch (error) {
    // Users can still select gyms manually.
  }
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
    S.gymMessage = 'Location is not supported. Choose a gym manually.';
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
          g.gym_id,
          distanceMiles(
            latitude,
            longitude,
            Number(g.lat),
            Number(g.lng)
          )
        ])
      );

      S.gymMessage =
        'Gyms sorted from closest to farthest (straight-line miles).';

      render();
    },
    error => {
      console.error('Geolocation error:', error);

      if (S.screen !== 'gym-select') return;

      S.gymDistances = null;
      S.gymMessage =
        'Location unavailable: ' + error.message +
        '. You can select a gym manually.';

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

  document.querySelectorAll('#theme-toggle, #login-theme-toggle')
  .forEach(button => {
    const isDark = currentTheme === 'dark';
    button.textContent = isDark ? 'Light Mode' : 'Dark Mode';
    button.setAttribute(
      'aria-label',
      isDark ? 'Switch to light mode' : 'Switch to dark mode'
    );
  });
}

applyTheme();

// ========================================
// HELPERS
// ========================================

const vnow = () => Date.now() + (
  upNextReady ? spotServerOffset : S.warp
);
const iso = time => new Date(time).toISOString();

const fmt = seconds => {
  seconds = Math.max(0, Math.ceil(seconds));
  return Math.floor(seconds / 60) + ':' +
    String(seconds % 60).padStart(2, '0');
};

const get = (id, gymId = S.gym?.gym_id) => 
  E.find(e => e.id === id && (gymId ? e.gym_id === gymId : true));

const mine = () =>
  E.filter(e => e.queue.includes('You') && e.gym_id === S.gym?.gym_id);


const using = () =>
  E.find(e => e.status === 'inuse' && e.by === 'You');

const wait = e => {
  if (!e || e.status === 'available') return 0;
  if (e.status === 'unavailable') return 0;

  if (e.status === 'inuse' && e.by === 'You') {
    return Math.ceil(Math.max(0, e.rem || 0) / 60);
  }

  const myPosition = e.queue.indexOf('You');

  const peopleAhead = myPosition >= 0
    ? myPosition
    : e.queue.length;

  const currentTime = e.status === 'inuse'
    ? Math.max(0, e.rem || 0)
    : e.status === 'reserved'
      ? Math.max(0, e.claimLeft || 0)
      : 0;

  const waitingSessions = e.status === 'reserved'
    ? Math.max(0, peopleAhead - 1)
    : peopleAhead;

  return Math.ceil(
    (currentTime + waitingSessions * AVG) / 60
  );
};

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

  if (screen === 'profile') {
    loadSpotProfile();
  }

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
  const average = getAverageWait(e.id);

  return `
    <button class="tile s-${e.status}"
            data-a="open"
            data-id="${e.id}">
      <b>${e.name}</b>

      <span class="pill s-${e.status}">
        ${LABEL[e.status]}
      </span>

      <span class="sub">${sub(e)}</span>

      <span class="average-wait">
        ${average !== null
          ? `⏱ 30-day avg: ${average} min`
          : '⏱ No wait history yet'}
      </span>
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
const adminExpanded = new Set();
let adminUsernames = new Map();
let adminNamesOwner = null;
let adminNamesKey = '';
let adminNamesStatus = 'idle';
let adminNamesLoadedAt = 0;
let adminNamesRequest = 0;

async function loadAdminUsernames() {
  if (S.screen !== 'admin' || !S.me) return;

  const owner = S.me;

  const ids = [...new Set(E.flatMap(e => [
    e.sess?.user_id,
    ...e.rows.map(row => row.user_id)
  ]).filter(id => id != null).map(String))].sort();

  if (adminNamesOwner !== owner) {
    adminUsernames.clear();
    adminNamesKey = '';
    adminNamesOwner = owner;
  }

  const key = JSON.stringify([owner, ids]);

  if (
    key === adminNamesKey &&
    (
      adminNamesStatus === 'loading' ||
      Date.now() - adminNamesLoadedAt < 30000
    )
  ) return;

  adminNamesKey = key;
  const request = ++adminNamesRequest;

  if (!ids.length) {
    adminNamesStatus = 'ready';
    adminNamesLoadedAt = Date.now();
    return;
  }

  adminNamesStatus = 'loading';

  try {
    const { data, error } = await db
      .from('users')
      .select('user_id, username')
      .in('user_id', ids);

    if (error) throw error;

    if (
      request !== adminNamesRequest ||
      S.me !== owner
    ) return;

    adminUsernames = new Map((data || []).map(user => [
      String(user.user_id),
      user.username?.trim() || ''
    ]));

    adminNamesStatus = 'ready';
  } catch (error) {
    if (
      request !== adminNamesRequest ||
      S.me !== owner
    ) return;

    adminNamesStatus = 'error';
    console.error('Admin usernames failed:', error);
  }

  adminNamesLoadedAt = Date.now();

  if (S.screen === 'admin' && S.me === owner) {
    render();
  }
}

function adminUsername(id) {
  if (id == null) return 'No user assigned';

  return adminUsernames.get(String(id)) || 'User #' + id;
}

function adminEquipmentList(
  machines,
  showUser = false,
  showTime = false
) {
  if (!machines.length) {
    return '<p class="hint">No matching equipment.</p>';
  }

  return `
    <ul class="admin-list">
      ${machines.map(e => {
        const userId = e.status === 'reserved'
          ? e.rows[0]?.user_id
          : e.sess?.user_id;

        return `
          <li>
            ${spotText(e.name)}

            ${showUser
              ? ' — ' + spotText(adminUsername(userId))
              : ''}

            ${showTime
              ? ' · ' + fmt(e.rem || 0) + ' remaining'
              : ''}
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function adminStatPanel(key, count, label, contents) {
  return `
    <details class="stat admin-stat"
             data-admin-panel="${key}"
             ${adminExpanded.has(key) ? 'open' : ''}>

      <summary id="admin-toggle-${key}">
        <b>${count}</b>
        ${label}
      </summary>

      <div class="admin-list-content">
        ${contents}
      </div>
    </details>
  `;
}

function adminDashboard() {
  // Preserve expanded lists during automatic page updates.
  app.querySelectorAll('details[data-admin-panel]')
    .forEach(panel => {
      if (panel.open) {
        adminExpanded.add(panel.dataset.adminPanel);
      } else {
        adminExpanded.delete(panel.dataset.adminPanel);
      }
    });

  void loadAdminUsernames();

  const available = E.filter(e =>
    e.status === 'available'
  );

  const inUse = E.filter(e =>
    e.status === 'inuse'
  );

  const reserved = E.filter(e =>
    e.status === 'reserved'
  );

  const unavailable = E.filter(e =>
    e.status === 'unavailable'
  );

  const queues = E.filter(e => e.rows.length);

  const totalInLines = queues.reduce(
    (total, e) => total + e.rows.length,
    0
  );

  const queueList = queues.length
    ? queues.map(e => `
        <h4>${spotText(e.name)}</h4>

        <ol class="admin-list">
          ${e.rows.map(row => `
            <li value="${Number(row.position)}">
              ${spotText(adminUsername(row.user_id))}
            </li>
          `).join('')}
        </ol>
      `).join('')
    : '<p class="hint">Nobody is waiting.</p>';

  return `
    <h2>Admin Dashboard</h2>

    <div class="card">
      <h3>Equipment Status</h3>

      <div class="stats admin-stats">
        ${adminStatPanel(
          'available',
          available.length,
          'Available',
          adminEquipmentList(available)
        )}

        ${adminStatPanel(
          'inuse',
          inUse.length,
          'In Use',
          adminEquipmentList(inUse, true)
        )}

        ${adminStatPanel(
          'reserved',
          reserved.length,
          'Reserved',
          adminEquipmentList(reserved, true)
        )}

        ${adminStatPanel(
          'unavailable',
          unavailable.length,
          'Unavailable',
          adminEquipmentList(unavailable)
        )}
      </div>
    </div>

    <div class="card">
      <h3>Users in Waitlists</h3>

      <p class="hint">
        Counts queue spots. A user on multiple machines
        appears in each line.
      </p>

      ${adminStatPanel(
        'waitlists',
        totalInLines,
        'Total in Lines',
        queueList
      )}
    </div>

    <div class="card">
      <h3>Current Sessions</h3>

      <p class="hint">
        Equipment workouts, not logged-in accounts.
      </p>

      ${adminStatPanel(
        'sessions',
        inUse.length,
        'Active Equipment Sessions',
        adminEquipmentList(inUse, true, true)
      )}
    </div>

    ${adminNamesStatus === 'loading'
      ? '<p class="hint">Loading usernames…</p>'
      : ''}

    ${adminNamesStatus === 'error'
      ? `<p class="hint" role="status">
           Could not load usernames.
           User IDs are shown where names are unavailable.
         </p>`
      : ''}
  `;
}

document.addEventListener('toggle', event => {
  const panel = event.target;

  if (
    !panel.matches?.('details[data-admin-panel]') ||
    !panel.isConnected
  ) return;

  if (panel.open) {
    adminExpanded.add(panel.dataset.adminPanel);
  } else {
    adminExpanded.delete(panel.dataset.adminPanel);
  }
}, true);

const V = {


profile: () => `
  <section class="profile-page">
    <h1>My Profile</h1>
    <p class="hint">Manage your Spot account and preferences.</p>

    <div class="card">
      <h2>Profile Information</h2>

      <div class="profile-avatar-section">
        <div id="profile-avatar-preview" class="profile-avatar">?</div>
        <input type="file" id="profile-picture"
               accept="image/png,image/jpeg,image/webp">
      </div>

      <label for="profile-username">Username</label>
      <input id="profile-username" placeholder="Username">

      <label for="profile-first">First Name</label>
      <input id="profile-first" placeholder="First name">

      <label for="profile-last">Last Name</label>
      <input id="profile-last" placeholder="Last name">

      <label for="profile-dob">Date of Birth</label>
      <input id="profile-dob" type="date">

      <button class="btn" id="profile-save">
        Save Profile
      </button>
    </div>

    <div class="card">
      <h2>Account & Security</h2>

      <label for="profile-email">Email Address</label>
      <input id="profile-email" type="email">

      <button class="btn alt" id="profile-email-save">
        Update Email
      </button>

      <h3 style="margin-top:24px">Change Password</h3>

      <label for="profile-password">New Password</label>
      <input id="profile-password" type="password"
             autocomplete="new-password">

      <label for="profile-password-confirm">
        Confirm New Password
      </label>
      <input id="profile-password-confirm" type="password"
             autocomplete="new-password">

      <button class="btn alt" id="profile-password-save">
        Change Password
      </button>
    </div>

    <div class="card">
      <h2>Preferences</h2>

      <label>
        <input type="checkbox" id="profile-notifications"
               style="width:auto;min-height:0">
        Enable Notifications
      </label>
    </div>
  </section>
`,


  

'gym-select': () => `
<section class="gym-selection-page spot-gym-page">
  <div class="gym-page-heading">
    <div>
      <h1>Choose a Spot Gym</h1>
      <p>Find a Spot gym near you and get directions with Google Maps.</p>
    </div>
    <button type="button" class="gym-location-action" data-a="find-nearby">
      ⌖ Use My Location
    </button>
  </div>

  <p class="hint gym-location-message" role="status">
    ${S.gymMessage || 'Location sharing is optional. You can select any gym.'}
  </p>

  <div class="gym-photo-grid">
    ${GYM_LOCATIONS.length ? gymOptions().map(g => {
      const selected = String(S.gymChoice) === String(g.gym_id);
      const location = String(g.name || 'Location');
      const slug = location.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const address = g.address || `${location}, Utah`;
      const safe = value => String(value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;'
      }[c]));

      return `
        <article class="spot-location-card ${selected ? 'chosen' : ''}">
          <div class="spot-location-image gym-photo-${slug}">
            ${g.distance !== null && Number.isFinite(g.distance) ? `
              <span class="spot-distance">⌖ ${g.distance.toFixed(1)} mi</span>
            ` : ''}
          </div>

          <div class="spot-location-body">
            <h2><span class="spot-mini-logo">🏋</span> Spot — ${safe(location)}</h2>
            <p class="spot-address">⌖ ${safe(address)}</p>

            <div class="spot-amenities">
              <span>Weights</span>
              <span>Cardio</span>
              <span>Equipment</span>
            </div>

            <div class="spot-card-actions">
              <button type="button"
                class="spot-select-btn ${selected ? 'selected' : ''}"
                data-a="choose-gym"
                data-g="${safe(g.gym_id)}"
                aria-pressed="${selected}">
                ${selected ? '✓ Selected' : 'Select Gym'}
              </button>

              <button type="button"
                class="spot-directions-btn"
                data-a="get-directions"
                data-g="${safe(g.gym_id)}">
                <span>📍</span> Get Directions
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('') : '<p class="hint">No gym locations available.</p>'}
  </div>

  <button type="button"
    class="btn gym-confirm-button"
    data-a="confirm-gym"
    ${!S.gymChoice ? 'disabled' : ''}>
    Confirm Gym &amp; Enter Spot →
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

        <div style="
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:8px 20px;
  margin:8px 0 0;
">

  <span>
    ${su ? 'Already have an account?' : 'New here?'}
    <button type="button" class="link" data-a="mode">
      ${su ? 'Log in' : 'Create an account'}
    </button>
  </span>

  ${!su ? `
    <button type="button" class="link" data-a="forgot-password">
      Forgot Password?
    </button>
  ` : ''}

</div>

      </form>
    `;
  },

    forgot: () => `
    <h1>Reset your password</h1>
    <form id="forgot-form" class="card">
      <p>Enter your email and we'll send you a password reset link.</p>

      <label for="reset-email">Email</label>
      <input id="reset-email" type="email" autocomplete="email" required>

      ${S.msg ? `<p class="${S.ok ? 'hint' : 'err'}">${S.msg}</p>` : ''}

      <button class="btn" type="submit">Send reset link</button>
      <button class="btn alt" type="button" data-a="back-login">
        Back to login
      </button>
    </form>
  `,

  reset: () => `
    <h1>Choose a new password</h1>
    <form id="reset-form" class="card">
      <label for="new-password">New password</label>
      <input id="new-password" type="password" minlength="6" required>

      <label for="confirm-new-password">Confirm new password</label>
      <input id="confirm-new-password" type="password" minlength="6" required>

      ${S.msg ? `<p class="err">${S.msg}</p>` : ''}

      <button class="btn" type="submit">Update password</button>
    </form>
  `,

  admin: () => adminDashboard(),
  
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
        You have ${mine().length + (upNextState.selection ? 1 : 0)}
        of ${MAXLISTS} waitlist / Up next spots.      </p>

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
      if (using()) {
        action = upNextReady ? `
          <p>
            This machine stays open for others
            until someone starts using it.
          </p>

          <button class="btn"
                  data-a="${upNextState.selection?.equipment_id === e.id
                    ? 'clear-next' : 'set-next'}"
                  data-id="${e.id}">
            ${upNextState.selection?.equipment_id === e.id
              ? 'Clear Up next' : 'Set as Up next'}
          </button>
        ` : `
          <p>
            Sign in with a verified account to select Up next.
          </p>
        `;
      } else {
        action = `
          <p>Choose your session length, then start.</p>
          ${mins()}
          <button class="btn" data-a="start">Start using</button>
        `;
      }
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
            const estimate = wait(e);

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
          ${using()
            ? 'Finish current workout and claim'
            : 'Claim equipment'}
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
  const gymId = S.gym?.gym_id;

  E = RAW.eq
    .filter(eq => gymId ? eq.gym_id === gymId : true)
    .map(q => {
      const rows = RAW.wl
        .filter(w => 
          w.equipment_id === q.equipment_id &&
          (gymId ? w.gym_id === gymId : true)
        )
        .sort((a, b) => a.position - b.position);

      const session = RAW.se.find(x =>
        x.equipment_id === q.equipment_id &&
        (!x.end_time || Date.parse(x.end_time) > now)
      );

      const e = {
        id: q.equipment_id,
        gym_id: gymId,
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
  const owner = S.me;

  try {
    if (owner) {
      const { data, error } = await db.auth.getSession();

      if (error) throw error;
      if (S.me !== owner) return false;

      if (data.session) {
        if (!await refreshEquipmentState()) return false;
      } else {
        resetUpNextState();
      }
    }

    const [a, b, c, d] = await Promise.all([
      db.from('equipment').select('*').order('equipment_id'),
      db.from('waitlist').select('*').order('position'),
      db.from('equipment_session').select('*'),
      db.from('gym_locations').select('*').order('name')
    ]);

    if (S.me !== owner) return false;

    const error = a.error || b.error || c.error || d.error;
    if (error) throw error;

    RAW = {
      eq: a.data || [],
      wl: b.data || [],
      se: c.data || [],
      gm: d.data || []
    };

    return true;
  } catch (error) {
    console.error('Equipment loading failed:', error);
    toast('Could not update equipment: ' + error.message);
    return false;
  }
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

let averageWaitStats = [];
function getAverageWait(equipmentId) {
  const record = averageWaitStats.find(
    row => Number(row.equipment_id) === Number(equipmentId)
  );

  return record
    ? Number(record.average_wait_minutes).toFixed(1)
    : null;
}

async function loadAverageWaitTimes() {
  const { data, error } = await db
    .rpc('get_equipment_average_wait');

  if (error) {
    console.error('Error loading wait times:', error);
    return;
  }

  averageWaitStats = data || [];
  console.log('Average wait times:', averageWaitStats);
  if (['map', 'detail'].includes(S.screen)) {
    render();
  }
}
loadAverageWaitTimes();

async function compact(eid) {
    if (upNextReady) {
      await refreshEquipmentState();
      return;
    }
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
  if (upNextReady) return;
  if (busy) return;
  if (!S.gym?.gym_id) return;

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
            ),
            gym_id: e.gym_id
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
  if (equipmentSyncPromise) return equipmentSyncPromise;

  const owner = S.me;

  equipmentSyncPromise = (async () => {
    if (await load() && S.me === owner) {
      derive();
      await maintain();
      checkWaitlistNotifications();
    }

    if (S.me === owner) view();
  })().finally(() => {
    equipmentSyncPromise = null;
  });

  return equipmentSyncPromise;
}

function view() {
  if (
    S.screen === 'gym-select' ||
    S.screen === 'login'
  ) return;

  const turns = E.filter(e =>
    e.status === 'reserved' &&
    e.rows[0]?.user_id === S.me &&
    e.claimLeft > 0
  );

    const currentClaim = turns.find(e => e.id === S.claim);

  if (!currentClaim) {
    S.claim = turns[0]?.id ?? null;

    if (S.screen === 'claim') {
      S.screen = 'map';
      S.stack = ['find'];
      S.msg = '';
    }
  }

  if (!['find', 'groups', 'profile', 'claim'].includes(S.screen)) {
    const y = window.scrollY;

    render();
    window.scrollTo(0, y);
  } else {
    updateUpNextPanel();
    updateEquipmentButtons();
  }
}

// ========================================
// RENDER
// ========================================


function updateSpotMenuAvatar() {
  const avatar = $('#menu-avatar');
  if (!avatar) return;

  if (S.avatarUrl) {
    avatar.textContent = '';
    avatar.style.backgroundImage = `url("${S.avatarUrl}")`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    avatar.style.backgroundRepeat = 'no-repeat';
  } else {
    avatar.style.backgroundImage = 'none';
    avatar.textContent = (S.name || '?').charAt(0).toUpperCase();
  }
}


async function uploadSpotProfilePicture(file) {
  if (!file) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

  if (!allowedTypes.includes(file.type)) {
    toast('Please choose a JPG, PNG, or WebP image.');
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    toast('Profile pictures must be under 5 MB.');
    return;
  }

  try {
    const { data: authData, error: authError } =
      await db.auth.getUser();

    if (authError) throw authError;
    if (!authData.user) throw new Error('Please sign in again.');

    const userId = authData.user.id;
    const extension = file.type === 'image/png'
      ? 'png'
      : file.type === 'image/webp'
        ? 'webp'
        : 'jpg';

    const filePath = `${userId}/${crypto.randomUUID()}.${extension}`;

    const { error: uploadError } = await db.storage
      .from('profile-pictures')
      .upload(filePath, file, {
        contentType: file.type,
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = db.storage
      .from('profile-pictures')
      .getPublicUrl(filePath);

    const imageUrl = urlData.publicUrl;

    const { data: updatedUser, error: saveError } = await db
      .from('users')
      .update({ avatar_url: imageUrl })
      .eq('auth_user_id', userId)
      .select('user_id')
      .single();

    if (saveError) throw saveError;
    if (!updatedUser) throw new Error('Could not save picture.');

    const avatar = $('#profile-avatar-preview');

    if (avatar) {
      avatar.textContent = '';
      avatar.style.backgroundImage = `url("${imageUrl}")`;
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
    }

    S.avatarUrl = imageUrl;
    updateSpotMenuAvatar();

    toast('Profile picture saved!');

  } catch (error) {
    console.error('Profile picture error:', error);
    toast('Picture upload failed: ' + error.message);
  }
}

async function loadSpotProfile() {
  if (S.screen !== 'profile') return;

  try {
    const { data: authData, error: authError } =
      await db.auth.getUser();

    if (authError) throw authError;
    
if (!authData.user) {
  toast('Please sign in to view your profile.');
  return;
}

// Fill email immediately from Supabase Auth
const emailInput = $('#profile-email');

if (emailInput) {
  emailInput.value = authData.user.email || '';
}

// Make sure the Auth account is linked to a Spot user
const spotUserId = await getSpotUser();

if (!spotUserId) {
  throw new Error('Could not find your Spot account.');
}

  const { data: profile, error } = await db
      .from('users')
      .select(`
        username,
        first_name,
        last_name,
        date_of_birth,
        avatar_url,
        notifications_enabled
      `)
      .eq('user_id', spotUserId)
      .single();

    if (error) throw error;
    if (S.screen !== 'profile') return;

    
    const defaultUsername = (authData.user.email || '').split('@')[0];
    S.name = profile.username || defaultUsername;
    S.avatarUrl = profile.avatar_url || null;

    const menuName = $('#menu-name');
    if (menuName) menuName.textContent = S.name || 'My Account';

    updateSpotMenuAvatar();

    $('#profile-username').value = profile.username || defaultUsername;
    $('#profile-first').value = profile.first_name || '';
    $('#profile-last').value = profile.last_name || '';
    $('#profile-dob').value = profile.date_of_birth || '';
    $('#profile-email').value = authData.user.email || '';

    S.notificationsEnabled =
      profile.notifications_enabled !== false;

    $('#profile-notifications').checked = S.notificationsEnabled;
    
    const avatar = $('#profile-avatar-preview');

    if (avatar) {
      if (profile.avatar_url) {
      avatar.textContent = '';
      avatar.style.backgroundImage =
        `url("${profile.avatar_url}")`;
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
      } else {
        avatar.style.backgroundImage = 'none';
        avatar.textContent = (
          profile.first_name ||
          profile.username ||
          authData.user.email ||
          '?'
        ).charAt(0).toUpperCase();
      }
}


  } catch (error) {
    console.error('Profile loading error:', error);
    toast('Could not load profile: ' + error.message);
  }
}


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
    upNextPanel() +
    V[S.screen]() +
    (S.screen === 'admin' ? equipmentUsageTable() : '');
    

  
  gymHeader();
  updateEquipmentButtons();

  // Remember the selected gym and current page.
  if (S.me && S.gym && S.screen !== 'claim') {
    saveView();
  }
  

  // Remember the selected gym and current page.
  if (S.me && S.gym && S.screen !== 'claim') {
    saveView();
  }


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

const loginThemeToggle = $('#login-theme-toggle');

if (loginThemeToggle) {
  loginThemeToggle.hidden =
    S.screen !== 'login' &&
    S.screen !== 'gym-select';
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

  if (menuName) menuName.textContent = S.name || 'My Account';

  updateSpotMenuAvatar();

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
  resetUpNextState();
  try {
    localStorage.setItem('spotUser', String(id));
  } catch (error) {}

  const cleanup = await db.rpc('close_stale_check_ins');

  if (cleanup.error) {
    toast('Could not check in: ' + cleanup.error.message);
    return;
  }

  await db.from('users')
    .update({ checked_in: true })
    .eq('user_id', id);

  const openRow = await db.from('check_ins')
    .select('check_in_id')
    .eq('user_id', id)
    .is('checked_out_at', null)
    .limit(1);

  if (!openRow.data || !openRow.data.length) {
    await db.from('check_ins').insert({ user_id: id });
  }

  const user = await db.from('users')
    .select('email, avatar_url, notifications_enabled')
    .eq('user_id', id)
    .maybeSingle();

  S.avatarUrl = user.data?.avatar_url || null;
  S.notificationsEnabled = user.data?.notifications_enabled !== false;
  S.name = user.data?.email
    ? user.data.email.split('@')[0]
    : '';

  S.me = id;
  S.checked = true;
  S.msg = '';
  S.email = user.data?.email || '';

  // Restore the user's previously selected gym
  restoreGymChoice();

  const { data: authData, error: authError } = await db.auth.getUser();

  if (!authError && authData.user?.email && authData.user.email_confirmed_at) {
    const verifiedEmail = authData.user.email.toLowerCase();

    const { data: updatedUser, error: syncError } = await db
      .from('users')
      .update({ email: verifiedEmail })
      .eq('user_id', id)
      .eq('auth_user_id', authData.user.id)
      .select('user_id');

    if (syncError) {
      console.error('Email sync error:', syncError);
    } else if (updatedUser?.length === 1) {
      S.email = verifiedEmail;
    }
  }


  await load();
  derive();

  resetGym();
  restoreGymChoice();




  
  S.screen = S.email === ADMIN_EMAIL
  ? 'admin'
  : 'gym-select';

  S.stack = [];

  render();

  if (S.screen === 'gym-select') {
    checkExistingLocationPermission();
  }

  if (S.screen === 'admin') {
    loadUsageStats();
  }
}

document.addEventListener('submit', async ev => {
  ev.preventDefault();
    if (ev.target.id === 'forgot-form') {
    const email = $('#reset-email').value.trim();

    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname + '?spot_reset=1'
    });

    S.msg = error
      ? error.message
      : 'If an account exists for that email, a reset link will be sent. Check your inbox.';

    S.ok = !error;
    render();
    return;
  }

  if (ev.target.id === 'reset-form') {
    const password = $('#new-password').value;

    if (password !== $('#confirm-new-password').value) {
      S.msg = 'Passwords do not match.';
      render();
      return;
    }

    const { error } = await db.auth.updateUser({ password });

    if (error) {
      S.msg = error.message;
      render();
      return;
    }

    await db.auth.signOut();
    spotRecoveryConfirmed = false;
    clearSpotResetUrl();
    S.screen = 'login';
    S.mode = 'login';
    S.msg = 'Password updated! Log in with your new password.';
    S.ok = true;
    render();
    return;
  }
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

    
    if (signup) {
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin +
            window.location.pathname
        }
      });

      if (error) {
        S.msg = error.message;
        render();
        return;
      }

      if (!data.session) {
        S.mode = 'login';
        S.ok = true;
        S.msg = 'Account created! Check your email and click the verification link before logging in.';
        render();
        return;
      }

      // Do not allow an unverified signup into Spot.
      await db.auth.signOut();
      S.mode = 'login';
      S.ok = true;
      S.msg = 'Check your email to verify your account.';
      render();
      return;
    }

    const { error } = await db.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
  // Temporary legacy login for local development only.
  const localDev =
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost';

  if (localDev) {
    const { data: oldAccount, error: oldError } = await db
      .from('users')
      .select('user_id')
      .eq('email', email)
      .eq('password', password)
      .is('auth_user_id', null)
      .maybeSingle();

    if (!oldError && oldAccount) {
      localStorage.setItem('spotLegacyUser', String(oldAccount.user_id));
      await enter(oldAccount.user_id);
      return;
    }
  }

  S.msg = error.message.toLowerCase().includes('not confirmed')
    ? 'Please verify your email before logging in.'
    : 'Incorrect email or password.';

  render();
  return;
}

    try {
      const id = await getSpotUser();

      if (!id) {
        await db.auth.signOut();
        S.msg = 'Please verify your email first.';
        render();
        return;
      }

      await enter(id);
    } catch (err) {
      S.msg = err.message;
      render();
    }
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


document.addEventListener('change', async (e) => {
  if (e.target.id === 'profile-picture') {
    const file = e.target.files?.[0];

    if (!file) return;

    e.target.disabled = true;

    try {
      await uploadSpotProfilePicture(file);
    } finally {
      e.target.disabled = false;
      e.target.value = '';
    }
  }
});


document.addEventListener('change', async (e) => {
  if (e.target.id !== 'profile-notifications') return;

  const checkbox = e.target;
  const enabled = checkbox.checked;

  checkbox.disabled = true;

  try {
    const { data: authData, error: authError } =
      await db.auth.getUser();

    if (authError) throw authError;
    if (!authData.user) throw new Error('Please sign in again.');

    const { data, error } = await db
      .from('users')
      .update({ notifications_enabled: enabled })
      .eq('auth_user_id', authData.user.id)
      .select('user_id')
      .single();

    if (error) throw error;
    if (!data) throw new Error('Preference was not saved.');
    S.notificationsEnabled = enabled;

    toast(enabled
      ? 'Notifications enabled!'
      : 'Notifications disabled!');

  } catch (error) {
    console.error('Notification preference error:', error);
    checkbox.checked = !enabled;
    toast('Could not save preference: ' + error.message);
  } finally {
    checkbox.disabled = false;
  }
});

document.addEventListener('click', event => {
  const wrap = $('#notification-wrap');
  const panel = $('#notification-panel');
  const toggle = $('#notification-toggle');

  if (!wrap || !panel || !toggle) return;

  if (!panel.hidden && !wrap.contains(event.target)) {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('click', async ev => {
  const b = ev.target.closest('button');
  if (!b) return;

  if (
    equipmentActionPending &&
    (
      b.id === 'co-yes' ||
      [
        'set-next', 'clear-next', 'start', 'finish',
        'join', 'cancel', 'claim'
      ].includes(b.dataset.a)
    )
  ) return;


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
    go('profile');
    return;
  }


if (b.id === 'profile-save') {
  const username = $('#profile-username').value.trim();
  const firstName = $('#profile-first').value.trim();
  const lastName = $('#profile-last').value.trim();
  const dob = $('#profile-dob').value;

  if (!username) {
    toast('Please enter a username.');
    return;
  }

  b.disabled = true;
  b.textContent = 'Saving...';

  try {
    const { data: authData, error: authError } =
      await db.auth.getUser();

    if (authError) throw authError;

    if (!authData.user) {
      throw new Error('Please sign in again.');
    }

    const { data, error } = await db
      .from('users')
      .update({
        username: username,
        first_name: firstName || null,
        last_name: lastName || null,
        date_of_birth: dob || null
      })
      .eq('auth_user_id', authData.user.id)
      .select('user_id')
      .single();

    if (error) throw error;
    if (!data) throw new Error('Profile was not updated.');

    S.name = username;

    const menuName = $('#menu-name');
    if (menuName) menuName.textContent = username;

    updateSpotMenuAvatar();

    toast('Profile saved successfully!');

  } catch (error) {
    console.error('Profile save error:', error);
    toast('Could not save profile: ' + error.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Save Profile';
  }

  return;
}


if (b.id === 'profile-email-save') {
  const newEmail = $('#profile-email').value.trim().toLowerCase();

  if (!newEmail) {
    toast('Please enter an email address.');
    return;
  }

  b.disabled = true;
  b.textContent = 'Updating...';

  try {
    const { data: authData, error: authError } =
      await db.auth.getUser();

    if (authError) throw authError;
    if (!authData.user) throw new Error('Please sign in again.');

    if (newEmail === authData.user.email?.toLowerCase()) {
      toast('That is already your email address.');
      return;
    }

    const { error } = await db.auth.updateUser(
      { email: newEmail },
      {
        emailRedirectTo:
          window.location.origin + window.location.pathname
      }
    );

    if (error) throw error;

    toast('Check your email to confirm the change!');

  } catch (error) {
    console.error('Email update error:', error);
    toast('Could not update email: ' + error.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Update Email';
  }

  return;
}


if (b.id === 'profile-password-save') {
  const password = $('#profile-password').value;
  const confirmPassword = $('#profile-password-confirm').value;

  if (password.length < 6) {
    toast('Password must be at least 6 characters.');
    return;
  }

  if (password !== confirmPassword) {
    toast('Passwords do not match.');
    return;
  }

  b.disabled = true;
  b.textContent = 'Updating...';

  try {
    const { data: authData, error: authError } =
      await db.auth.getUser();

    if (authError) throw authError;
    if (!authData.user) throw new Error('Please sign in again.');

    const { error } = await db.auth.updateUser({
      password: password
    });

    if (error) throw error;

    $('#profile-password').value = '';
    $('#profile-password-confirm').value = '';

    toast('Password updated successfully!');

  } catch (error) {
    console.error('Password update error:', error);
    toast('Could not update password: ' + error.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Change Password';
  }

  return;
}

  if (b.id === 'theme-toggle' || b.id === 'login-theme-toggle') {
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
    if (
      upNextReady &&
      !await runEquipmentAction('clear')
    ) return;

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

    await db.auth.signOut();
    
    try {
      localStorage.removeItem('spotUser');
      localStorage.removeItem('spotView');
      localStorage.removeItem('spotLegacyUser');
    } catch (error) {}

    S.me = null;

    resetUpNextState();
    spotNotifications.length = 0;
    notifiedTurns.clear();
    renderSpotNotifications();

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
    if (a === 'show-claim') {
    if (
      e?.status === 'reserved' &&
      e.rows[0]?.user_id === S.me &&
      e.claimLeft > 0
    ) {
      S.claim = e.id;
      go('claim');
    }

    return;
  }

  if (a === 'set-next' || a === 'clear-next') {
    if (
      a === 'set-next' &&
      upNextState.selection &&
      upNextState.selection.equipment_id !== e?.id &&
      !window.confirm('Replace your current Up next selection?')
    ) return;

    const ok = await runEquipmentAction(
      a === 'set-next' ? 'set' : 'clear',
      e?.id ?? null
    );

    if (ok) {
      toast(a === 'set-next'
        ? 'Up next selected. This machine stays open for others.'
        : 'Up next cleared.');
    }

    return;
  }

  if (
    upNextReady &&
    ['start', 'finish', 'join', 'cancel', 'claim'].includes(a)
  ) {
    const id = a === 'claim'
      ? S.claim
      : ['start', 'join'].includes(a)
        ? S.sel
        : e?.id;

    if (!id) return;

    const current = using();
    const finishCurrent =
      a === 'claim' && Boolean(current);

    if (
      finishCurrent &&
      !window.confirm(
        'Finish your workout on ' + current.name +
        ' and claim ' + get(id)?.name + '?'
      )
    ) return;

    const action = a === 'claim'
      ? 'start'
      : a === 'cancel'
        ? 'leave'
        : a;

    const ok = await runEquipmentAction(
      action,
      id,
      finishCurrent
    );

        if (!ok) return;

    if (a === 'claim') {
      spotNotifications
        .filter(n => n.equipment_id === id && !n.claimed)
        .forEach(n => {
          n.claimed = true;
          n.read = true;
          n.claimedAt = Date.now();
        });

      renderSpotNotifications();
    }

    if (a === 'start' || a === 'claim') {
  S.claim = null;
  S.sel = id;
  S.screen = 'detail';
  S.stack = ['find', 'map'];

  // Reload the equipment and session data immediately
  const refreshed = await load();

  if (refreshed) {
    derive();
  }

  render();

  toast('Your session timer has started.');
} else if (a === 'join') {
      for (let i = spotNotifications.length - 1; i >= 0; i--) {
        if (spotNotifications[i].claimed) {
          spotNotifications.splice(i, 1);
        }
      }

      renderSpotNotifications();
      go('mylists');
    } else if (a === 'finish') {
      toast('Session finished.');
    } else {
      toast('Your spot was removed. Your current workout continues.');
    }

    render();
    return;
  }


  // GYM SELECTION ACTIONS


if (a === 'get-directions' && S.screen === 'gym-select') {
  const gym = GYM_LOCATIONS.find(
    g => String(g.gym_id) === String(b.dataset.g)
  );

  if (!gym) return;

  const lat = Number(gym.lat);
  const lng = Number(gym.lng);

  let destination;

  if (gym.lat != null && gym.lng != null &&
    Number.isFinite(lat) && Number.isFinite(lng)) {
    destination = `${lat},${lng}`;
  } else {
    destination = gym.address || `${gym.name}, Utah`;
  }

  const url = 'https://www.google.com/maps/dir/?api=1' +
    '&destination=' + encodeURIComponent(destination) +
    '&travelmode=driving';

  window.open(url, '_blank', 'noopener,noreferrer');
  return;
}


  if (a === 'find-nearby' && S.screen === 'gym-select') {
    findNearbyGyms();
    return;
  }

  if (a === 'choose-gym' && S.screen === 'gym-select') {
    const chosen = GYM_LOCATIONS.find(
      g => String(g.gym_id) === String(b.dataset.g)
    );

    S.gymChoice = chosen?.gym_id ?? null;
    render();
    return;
  }

  if (
    a === 'confirm-gym' &&
    S.screen === 'gym-select' &&
    !S.gym
  ) {
    const gym = GYM_LOCATIONS.find(
      g => String(g.gym_id) === String(S.gymChoice)
    );

    if (!gym) {
      S.msg = 'Selected gym not found. Please select again.';
      render();
      return;
    }

    S.gym = gym;
    S.gymChoice = gym.gym_id;

    try {
      localStorage.setItem(savedGymKey(), String(gym.gym_id));
    } catch (error) {
      console.error('Could not save gym preference:', error);
    }

    S.screen = 'find';
    S.stack = [];
    S.msg = '';

    saveView();
    render();
    return;
  }

    if (a === 'forgot-password') {
    S.screen = 'forgot';
    S.msg = '';
    S.ok = false;
    render();
    return;
  }

  if (a === 'back-login') {
    clearSpotResetUrl();
    S.screen = 'login';
    S.mode = 'login';
    S.msg = '';
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

    spotNotifications
      .filter(n => n.equipment_id === c.id && !n.claimed)
      .forEach(n => {
        n.claimed = true;
        n.read = true;
        n.claimedAt = Date.now();     
      });

    renderSpotNotifications();

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
  updateNotificationClaimTimers();

  if (S.screen === 'claim') {
    const equipment = get(S.claim);
    const timer = app.querySelector('.claim-card .big');

    if (timer && equipment) {
      timer.textContent = fmt(equipment.claimLeft);
    }
  }

  view();
}, 1000);


let syncRunning = false;

async function fastSync() {
  if (
    !S.me ||
    syncRunning ||
    equipmentActionPending ||
    document.hidden
  ) return;
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
    mine().length ||
    upNextState.selection
  ) {
    return;
  }

  const id = S.me;
  S.me = null;
  resetUpNextState();
  spotNotifications.length = 0;
  notifiedTurns.clear();
  renderSpotNotifications();
  await db.auth.signOut();

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
    localStorage.removeItem('spotLegacyUser');
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
    S.screen === 'claim' ||
    !S.gym
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
        gymId: S.gym?.gym_id
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
  } catch (error) {
    return;
  }

  if (!saved || String(saved.u) !== String(S.me)) return;

  const gym = GYM_LOCATIONS.find(
    g => String(g.gym_id) === String(saved.gymId)
  );

  if (!gym) return;

  S.gym = gym;
  S.gymChoice = gym.gym_id;

  const allowed = [
    'find',
    'groups',
    'map',
    'detail',
    'mylists',
    'profile'
  ];

  S.screen = allowed.includes(saved.screen)
    ? saved.screen
    : 'find';

  S.stack = Array.isArray(saved.stack)
    ? saved.stack.filter(s => allowed.includes(s))
    : [];

  S.sel = saved.sel;
  S.group = saved.group;
  S.q = saved.q || '';

  if (S.screen === 'detail' && !get(S.sel)) {
    S.screen = 'find';
  }

  render();

  if (S.screen === 'profile') {
    loadSpotProfile();
  }
}

// Supabase fires this when a password recovery link is verified.
db.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    spotRecoveryConfirmed = true;

    S.screen = 'reset';
    S.msg = '';
    S.ok = false;

    render();
  }
});

// ========================================
// INITIALIZE APPLICATION
// ========================================

render();

function finishStartup() {
  document.documentElement.classList.remove('spot-loading');
}


(async () => {
  try {
    await loadGymLocations();
    console.log('Gym locations loaded successfully');
  } catch (error) {
    console.error('Failed to load gym locations:', error);
  }

  try {
    const { data: sessionData } =
      await db.auth.getSession();
      if (spotRecoveryLink || spotRecoveryConfirmed) {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));

  const linkError =
    params.get('error_description') ||
    hash.get('error_description');

  if (linkError || !sessionData.session) {
    S.screen = 'forgot';

    S.msg = linkError
      ? 'Reset link error: ' + linkError.replace(/\+/g, ' ')
      : 'This reset link is invalid or expired. Request a new one.';

    S.ok = false;
  } else {
    S.screen = 'reset';
    S.msg = '';
  }

  render();
  return;
}

    if (!sessionData.session) {
  const localDev =
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost';

  const legacyId = localDev
    ? Number(localStorage.getItem('spotLegacyUser'))
    : 0;

  const lastSeen =
    Number(localStorage.getItem('spotSeen')) || 0;

  if (legacyId && (!lastSeen || Date.now() - lastSeen <= IDLE_MS)) {
    const { data: account } = await db
      .from('users')
      .select('user_id')
      .eq('user_id', legacyId)
      .is('auth_user_id', null)
      .maybeSingle();

    if (account) {
      await enter(account.user_id);
      restoreView();
      return;
    }
  }

  localStorage.removeItem('spotLegacyUser');
  localStorage.removeItem('spotUser');
  localStorage.removeItem('spotView');
  return;
}

    const lastSeen =
      Number(localStorage.getItem('spotSeen')) || 0;

    if (lastSeen && Date.now() - lastSeen > IDLE_MS) {
      await db.auth.signOut();
      localStorage.removeItem('spotUser');
      localStorage.removeItem('spotView');
      return;
    }

    const id = await getSpotUser();

    if (!id) {
      await db.auth.signOut();
      return;
    }

    await enter(id);
    restoreView();

    } catch (error) {
    console.error('Could not restore login:', error);
    S.screen = 'login';
    S.msg = 'Please log in again.';
    render();
  } finally {
    finishStartup();
  }
})();
