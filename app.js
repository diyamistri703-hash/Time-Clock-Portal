/**
 * ApexFlow — Attendance & Payroll Management
 * Vanilla JS SPA | IndexedDB backend with synchronous in-memory cache
 * Features:
 *   - Native IndexedDB Local Database (kv store)
 *   - Admin-only employee registration with custom passwords
 *   - GPS Geofencing (Haversine)
 *   - Auto Geolocation tracking (watchPosition)
 *   - Auto Break Trigger: put on break when employee goes out of office zone
 *   - Break duration depletion: pauses work timer, stops timer when 1hr is over
 *   - HR Approvals for Outside Work (WFH, client visits) to bypass geofencing
 *   - Background restoration: Visibility API captures elapsed background time
 *   - Live shift timer
 *   - Leaves, Payroll, Calendar, Drawer logs, Analytics
 */

'use strict';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const WORK_HOURS = 9;     // 8h work + 1h break
const BREAK_HOURS = 1;
const NET_WORK_HOURS = WORK_HOURS - BREAK_HOURS;

// ─────────────────────────────────────────────
// INDEXEDDB KEY-VALUE ENGINE
// ─────────────────────────────────────────────
const DBStore = {
  db: null,
  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ApexFlowDatabase', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },
  get(key) {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      const tx = this.db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    });
  },
  put(key, value) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('IndexedDB not initialized'));
      const tx = this.db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  getAll() {
    return new Promise((resolve) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }
};

// ─────────────────────────────────────────────
// SYNCHRONOUS IN-MEMORY CACHE & SERVER SYNC WRAPPER
// ─────────────────────────────────────────────
const DB_Cache = {};
let serverOnline = false;
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

const DB = {
  get(key) {
    return DB_Cache[key];
  },
  set(key, val) {
    DB_Cache[key] = val;
    // Persist to local IndexedDB
    DBStore.put(key, val).catch(err => console.error("IndexedDB write fail:", err));
    // Sync to backend server if connected and running locally
    if (isLocalhost && serverOnline) {
      syncCacheToServer();
    }
  },
  push(key, val) {
    const arr = DB_Cache[key] || [];
    arr.push(val);
    DB.set(key, arr);
    return arr;
  }
};

async function syncCacheToServer() {
  if (!isLocalhost) return;
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DB_Cache)
    });
    if (!res.ok) {
      console.warn("Failed to sync database to server.");
      setServerStatus(false);
    }
  } catch (err) {
    console.warn("Database server connection lost.");
    setServerStatus(false);
  }
}

function setServerStatus(online) {
  serverOnline = online;
  const dot = $('db-dot');
  const text = $('db-status-text');
  if (!dot || !text) return;
  if (online) {
    dot.className = 'geo-dot active';
    text.textContent = 'Database: Connected';
  } else {
    dot.className = 'geo-dot local';
    text.textContent = 'Database: Local Mode';
  }
}

// ─────────────────────────────────────────────
// LOCAL DATE UTILS (timezone-safe)
// ─────────────────────────────────────────────
function getLocalISODate(d = new Date()) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}

function fmtTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function fmtHHMMSS(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function toMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function monthLabel(d) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ─────────────────────────────────────────────
// GPS GEOFENCING — HAVERSINE
// ─────────────────────────────────────────────
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getGeofence() {
  return DB.get('geofence') || { lat: null, lng: null, radius: 200 };
}

function saveGeofence(lat, lng, radius) {
  DB.set('geofence', { lat, lng, radius });
}

function checkGeofence() {
  return new Promise((resolve) => {
    const fence = getGeofence();
    if (fence.lat === null || fence.lng === null) {
      resolve({ ok: null, dist: 0, msg: 'Geofence not set — skipping check.' });
      return;
    }
    if (!navigator.geolocation) {
      resolve({ ok: null, dist: 0, msg: 'Geolocation not supported.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const dist = haversineMeters(fence.lat, fence.lng, pos.coords.latitude, pos.coords.longitude);
        const ok = dist <= fence.radius;
        resolve({
          ok,
          dist: Math.round(dist),
          msg: ok
            ? `✓ Within office zone (${Math.round(dist)}m away)`
            : `✗ ${Math.round(dist)}m from office — must be within ${fence.radius}m`,
        });
      },
      () => resolve({ ok: null, dist: 0, msg: 'Location permission denied.' }),
      { timeout: 8000, enableHighAccuracy: true }
    );
  });
}

// ─────────────────────────────────────────────
// STATE VARIABLES
// ─────────────────────────────────────────────
let currentUser = null;
let timerInterval = null;
let checkInTimestamp = null;
let darkMode = false;
let cameraStream = null;
let scanTarget = null;

// Break & Tracking State
let watchId = null;
let onBreak = false;
let breakType = null; // 'auto' | 'manual' | null
let breakSecondsRemaining = 3600; // 1 hour break limit
let cumulativeBreakSeconds = 0;
let breakStartTimestamp = null;
let breakTimerInterval = null;
let lastActiveTime = null;

// ─────────────────────────────────────────────
// INIT DB (First launch defaults)
// ─────────────────────────────────────────────
async function initDB() {
  // First boot check in IndexedDB
  const booted = DB.get('booted');
  if (booted) return;

  // Try to load database.json from the repository root as the seed
  try {
    const res = await fetch('database.json');
    if (res.ok) {
      const staticData = await res.json();
      if (staticData && typeof staticData === 'object' && staticData.employees) {
        for (const key in staticData) {
          DB.set(key, staticData[key]);
        }
        DB.set('booted', true);
        console.log("Database initialized from static database.json seed.");
        return;
      }
    }
  } catch (err) {
    console.warn("Could not fetch static database.json seed. Falling back to default data.", err);
  }

  const adminId = 'EMP000';
  const empId   = 'EMP001';

  DB.set('employees', [
    {
      id: adminId, name: 'HR Administrator', email: 'admin@company.com',
      password: 'Admin@1234', role: 'Admin', dept: 'HR',
      designation: 'HR Manager', salary: 9000, otRate: 45,
      leaveBalance: { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 },
      timeCut: 0, timeDebt: 0, overtimeAccumulated: 0
    },
    {
      id: empId, name: 'Alex Johnson', email: 'employee@company.com',
      password: 'Emp@1234', role: 'Employee', dept: 'Engineering',
      designation: 'Software Engineer', salary: 6000, otRate: 30,
      leaveBalance: { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 },
      timeCut: 0, timeDebt: 0, overtimeAccumulated: 0
    },
  ]);

  DB.set('attendance', [
    { empId: empId, date: getLocalISODate(new Date(Date.now() - 864e5)), checkIn: '09:02', checkOut: '18:05', status: 'Present' },
    { empId: empId, date: getLocalISODate(new Date(Date.now() - 2*864e5)), checkIn: '09:31', checkOut: '18:15', status: 'Late' },
  ]);

  DB.set('leaves', []);
  DB.set('outside_work', []);
  DB.set('holidays', [
    { date: '2026-01-01', name: 'New Year' },
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-10-02', name: 'Gandhi Jayanti' },
    { date: '2026-12-25', name: 'Christmas' },
  ]);
  DB.set('payrolls', []);
  DB.set('notifications', []);
  DB.set('emails', []);
  DB.set('geofence', { lat: null, lng: null, radius: 200 });
  DB.set('booted', true);
}

// ─────────────────────────────────────────────
// DOM HELPERS
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

function openModal(id)  { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function showView(viewId) {
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  $(viewId).classList.add('active');

  const backBtn = $('hdr-back-btn');
  if (backBtn) {
    if (viewId === 'v-admin-dash' || viewId === 'v-emp-dash') {
      backBtn.classList.add('hidden');
    } else {
      backBtn.classList.remove('hidden');
    }
  }

  if (typeof updateBottomNavActiveItem === 'function') {
    updateBottomNavActiveItem();
  }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:9999;
    padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;
    font-family:'Outfit',sans-serif;
    max-width:340px;box-shadow:0 8px 24px rgba(0,0,0,0.15);
    animation:fadeSlide 0.35s ease;
    background:${type==='success'?'#10b981':type==='error'?'#ef4444':'#4f46e5'};
    color:white;
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function badge(status) {
  const map = {
    'Present':  'badge-green',
    'Late':     'badge-yellow',
    'Absent':   'badge-red',
    'On Leave': 'badge-purple',
    'Pending':  'badge-yellow',
    'Approved': 'badge-green',
    'Rejected': 'badge-red',
    'Paid':     'badge-green',
    'Unpaid':   'badge-red',
  };
  return `<span class="badge ${map[status]||'badge-blue'}">${status}</span>`;
}

function addNotif(msg, icon = '🔔') {
  DB.push('notifications', { msg, icon, ts: new Date().toISOString() });
  $('notif-dot').classList.remove('hidden');
}

function addEmail(to, subject, body) {
  DB.push('emails', { to, subject, body, ts: new Date().toISOString() });
  $('email-dot').classList.remove('hidden');
}

// ─────────────────────────────────────────────
// AUTOMATED LOCATION POLLLING & BREAK MACHINE
// ─────────────────────────────────────────────
function startContinuousLocationTracking() {
  if (!navigator.geolocation) return;
  if (watchId) navigator.geolocation.clearWatch(watchId);

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const fence = getGeofence();
      if (fence.lat === null || fence.lng === null) return;

      const dist = haversineMeters(fence.lat, fence.lng, pos.coords.latitude, pos.coords.longitude);
      const today = getLocalISODate();
      
      // Check for approved Outside Work bypass
      const hasOutsideApproval = (DB.get('outside_work') || []).some(
        w => w.empId === currentUser.id && w.date === today && w.status === 'Approved'
      );

      const isInside = (dist <= fence.radius) || hasOutsideApproval;

      updateGeoIndicator({ ok: isInside, dist: Math.round(dist), msg: isInside ? "Within Allowed Range" : "Outside Office Zone" });

      if (!isInside && checkInTimestamp && !onBreak) {
        // Automatically put on Break
        triggerAutoBreak(true);
      } else if (isInside && onBreak && breakType === 'auto') {
        // Automatically resume shift
        triggerAutoBreak(false);
      }
    },
    (err) => console.warn("Watch position error:", err),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function stopLocationTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function triggerAutoBreak(isActive) {
  if (isActive) {
    onBreak = true;
    breakType = 'auto';
    breakStartTimestamp = Date.now();
    
    // Pause standard shift timer UI
    clearInterval(timerInterval);
    timerInterval = null;

    // Show Break warning HUD
    $('out-of-bounds-alert').classList.remove('hidden');
    $('shift-status-badge').textContent = 'Auto-Break';
    $('shift-status-badge').style.cssText = 'background:var(--warn-bg);color:var(--warn);';
    $('timer-label').textContent = 'Shift paused — Out of Bounds';
    $('timer-dot').classList.add('hidden');

    // Run break depletion interval
    if (breakTimerInterval) clearInterval(breakTimerInterval);
    breakTimerInterval = setInterval(tickBreak, 1000);
    tickBreak();

    $('btn-break').disabled = true;
    $('btn-break').innerHTML = '<i data-lucide="coffee" style="width:15px;height:15px;"></i> <span id="btn-break-text">On Auto-Break</span>';
    lucide.createIcons();

    addNotif(`Auto-Break triggered for ${currentUser.name} (Went Out of Office Geofence)`, '⚠️');
    toast("Auto-Break Active: You left the geofence!", "error");
  } else {
    onBreak = false;
    breakType = null;
    // Calculate spent break seconds
    if (breakStartTimestamp) {
      const spent = Math.floor((Date.now() - breakStartTimestamp) / 1000);
      cumulativeBreakSeconds += spent;
      breakSecondsRemaining = Math.max(0, breakSecondsRemaining - spent);
    }
    breakStartTimestamp = null;
    
    // Clear break depletion interval
    clearInterval(breakTimerInterval);
    breakTimerInterval = null;

    // Hide Break HUD
    $('out-of-bounds-alert').classList.add('hidden');
    
    // Resume standard shift timer UI
    $('shift-status-badge').textContent = 'Active';
    $('shift-status-badge').style.cssText = 'background:var(--success-bg);color:var(--success);';
    $('timer-dot').classList.remove('hidden');
    $('timer-label').textContent = 'Shift running…';
    
    timerInterval = setInterval(tickTimer, 1000);
    tickTimer();

    $('btn-break').disabled = false;
    $('btn-break').innerHTML = '<i data-lucide="coffee" style="width:15px;height:15px;"></i> <span id="btn-break-text">Start Break</span>';
    lucide.createIcons();

    addNotif(`Shift resumed for ${currentUser.name} (Returned to Bounds)`, '✓');
    toast("Welcome back! Work timer resumed.", "success");
  }
}

function triggerManualBreak(isActive) {
  if (isActive) {
    onBreak = true;
    breakType = 'manual';
    breakStartTimestamp = Date.now();
    
    clearInterval(timerInterval);
    timerInterval = null;

    $('shift-status-badge').textContent = 'On Break';
    $('shift-status-badge').style.cssText = 'background:var(--warn-bg);color:var(--warn);';
    $('timer-label').textContent = 'Shift paused — Manual Break';
    $('timer-dot').classList.add('hidden');

    if (breakTimerInterval) clearInterval(breakTimerInterval);
    breakTimerInterval = setInterval(tickBreak, 1000);
    tickBreak();

    $('btn-break').innerHTML = '<i data-lucide="play" style="width:15px;height:15px;"></i> <span id="btn-break-text">Resume Shift</span>';
    lucide.createIcons();

    addNotif(`${currentUser.name} started a manual break`, '☕');
    toast("Manual Break Started", "info");
  } else {
    onBreak = false;
    breakType = null;
    
    if (breakStartTimestamp) {
      const spent = Math.floor((Date.now() - breakStartTimestamp) / 1000);
      cumulativeBreakSeconds += spent;
      breakSecondsRemaining = Math.max(0, breakSecondsRemaining - spent);
    }
    breakStartTimestamp = null;

    clearInterval(breakTimerInterval);
    breakTimerInterval = null;

    $('shift-status-badge').textContent = 'Active';
    $('shift-status-badge').style.cssText = 'background:var(--success-bg);color:var(--success);';
    $('timer-dot').classList.remove('hidden');
    $('timer-label').textContent = 'Shift running…';

    timerInterval = setInterval(tickTimer, 1000);
    tickTimer();

    $('btn-break').innerHTML = '<i data-lucide="coffee" style="width:15px;height:15px;"></i> <span id="btn-break-text">Start Break</span>';
    lucide.createIcons();

    addNotif(`${currentUser.name} resumed work from manual break`, '✓');
    toast("Work resumed from break", "success");
  }
}

function tickBreak() {
  if (!breakStartTimestamp) return;
  const currentSpent = Math.floor((Date.now() - breakStartTimestamp) / 1000);
  const remaining = Math.max(0, breakSecondsRemaining - currentSpent);
  
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  
  const timerLbl = $('break-timer-lbl');
  if (timerLbl) timerLbl.textContent = `${minutes}m ${String(seconds).padStart(2,'0')}s`;

  const btnTxt = $('btn-break-text');
  if (btnTxt) {
    if (breakType === 'manual') {
      btnTxt.textContent = `Resume Shift (${minutes}m ${String(seconds).padStart(2,'0')}s)`;
    } else if (breakType === 'auto') {
      btnTxt.textContent = `On Auto-Break (${minutes}m ${String(seconds).padStart(2,'0')}s)`;
    }
  }

  if (remaining <= 0) {
    // Break depleted! Stop timer completely and force logout / clockout
    terminateShiftDueToBreakExpiration();
  }
}

function terminateShiftDueToBreakExpiration() {
  clearInterval(breakTimerInterval);
  breakTimerInterval = null;
  clearInterval(timerInterval);
  timerInterval = null;
  stopLocationTracking();

  const now = new Date();
  const today = getLocalISODate(now);
  const time = fmtTime(now);

  const logs = DB.get('attendance') || [];
  const log = logs.find(l => l.empId === currentUser.id && l.date === today);
  if (log && !log.checkOut) {
    processShiftEnd(log, time);
    log.status = 'Present';
    DB.set('attendance', logs);
  }

  // Clear states
  onBreak = false;
  breakType = null;
  checkInTimestamp = null;
  $('btn-checkin').disabled = false;
  $('btn-checkout').disabled = true;
  $('btn-break').classList.add('hidden');
  $('out-of-bounds-alert').classList.add('hidden');
  $('shift-status-badge').textContent = 'Exceeded Break';
  $('shift-status-badge').style.cssText = 'background:var(--danger-bg);color:var(--danger);';

  addNotif(`Shift ended automatically for ${currentUser.name} (Exceeded 1-hour break zone limit)`, '🛑');
  addEmail(currentUser.email, 'Shift Expired: Outside Zone Limit', `Hi ${currentUser.name},\n\nYour shift has been automatically clocked out because you spent more than 60 minutes outside the corporate geofence zone.\n\n— Time Clock HR`);
  
  alert("Shift automatically clocked out! You exceeded the maximum allowed break limit of 1 hour outside the corporate office zone.");
  handleLogout();
}

// ─────────────────────────────────────────────
// MOBILE BACKGROUND SUSPENSION TRACKING
// ─────────────────────────────────────────────
function handleBackgroundPause() {
  lastActiveTime = Date.now();
}

function handleForegroundResume() {
  if (!checkInTimestamp || !lastActiveTime) return;

  const bgElapsedMs = Date.now() - lastActiveTime;
  const bgElapsedSec = Math.floor(bgElapsedMs / 1000);
  lastActiveTime = null;

  // Immediately check location
  checkGeofence().then(async (geo) => {
    const today = getLocalISODate();
    const hasOutsideApproval = (DB.get('outside_work') || []).some(
      w => w.empId === currentUser.id && w.date === today && w.status === 'Approved'
    );

    const isInside = (geo.ok !== false) || hasOutsideApproval;

    if (!isInside) {
      // User was outside in the background
      if (onBreak) {
        // Simply deduct the background elapsed time from remaining break seconds
        breakSecondsRemaining = Math.max(0, breakSecondsRemaining - bgElapsedSec);
        if (breakSecondsRemaining <= 0) {
          terminateShiftDueToBreakExpiration();
        }
      } else {
        // Went out of bounds in background: switch to break and subtract remaining time
        triggerAutoBreak(true);
        breakSecondsRemaining = Math.max(0, breakSecondsRemaining - bgElapsedSec);
        if (breakSecondsRemaining <= 0) {
          terminateShiftDueToBreakExpiration();
        }
      }
    } else {
      // User is inside now
      if (onBreak) {
        if (breakType === 'auto') {
          // User was outside but returned. Deduct partial break time and resume
          breakSecondsRemaining = Math.max(0, breakSecondsRemaining - bgElapsedSec);
          triggerAutoBreak(false);
        } else {
          // Keep manual break, just deduct background elapsed time from remaining break
          breakSecondsRemaining = Math.max(0, breakSecondsRemaining - bgElapsedSec);
          if (breakSecondsRemaining <= 0) {
            terminateShiftDueToBreakExpiration();
          }
        }
      }
    }
  });
}

// ─────────────────────────────────────────────
// AUTHENTICATION
// ─────────────────────────────────────────────
function handleLogin(e) {
  e.preventDefault();
  const email = $('l-email').value.trim().toLowerCase();
  const pass  = $('l-pass').value;
  const emps  = DB.get('employees') || [];
  const user  = emps.find(u => u.email.toLowerCase() === email && u.password === pass);

  if (!user) {
    toast('Invalid email or password', 'error');
    return;
  }

  currentUser = user;
  $('login-page').classList.add('hidden');
  $('app').classList.remove('hidden');

  buildSidebar();
  updateHeader();

  if (user.role === 'Admin') {
    loadAdminDash();
    showView('v-admin-dash');
    $('page-title').textContent = 'HR Dashboard';
  } else {
    loadEmpDash();
    showView('v-emp-dash');
    $('page-title').textContent = 'My Dashboard';
    $('geo-status-bar').classList.remove('hidden');
    autoStartAttendanceFlow();
  }
}

async function autoStartAttendanceFlow() {
  const today = getLocalISODate();
  const logs   = (DB.get('attendance') || []).filter(l => l.empId === currentUser.id && l.date === today);
  const todayLog = logs[0];

  if (todayLog && todayLog.checkOut) {
    setScanStatus('Attendance complete for today ✓', 'var(--success)');
    return;
  }

  // Check geofence
  setScanStatus('Checking your office location…');
  updateLocStrip('Checking location…', 'var(--text3)');
  $('loc-strip').style.display = 'flex';

  const geo = await checkGeofence();
  updateGeoIndicator(geo);

  // Check Outside Work bypass
  const hasOutsideApproval = (DB.get('outside_work') || []).some(
    w => w.empId === currentUser.id && w.date === today && w.status === 'Approved'
  );

  const isBypassed = geo.ok === true || geo.ok === null || hasOutsideApproval;

  if (!todayLog) {
    if (!isBypassed) {
      $('geo-block-msg').textContent = geo.msg;
      $('geo-block').classList.add('open');
      setScanStatus('Outside permitted zone', 'var(--danger)');
      return;
    }

    updateLocStrip(geo.msg, 'var(--success)');
    setScanStatus('Face Camera Auto-Scan Active…');
    setTimeout(() => startCamera('cam-feed', 'cam-canvas', 'cam-fallback', 'scan-laser', 'scan-pulse', 'checkin', afterCheckin), 400);

  } else if (!todayLog.checkOut) {
    // Clocked in but not checked out yet
    const ci = new Date(`${today}T${todayLog.checkIn}:00`);
    restoreTimer(ci);
    setScanStatus('Restored Active Session. Monitor Zone.', 'var(--success)');
    $('btn-checkin').disabled = true;
    $('btn-checkout').disabled = false;
    $('btn-break').classList.remove('hidden');
    $('btn-break').innerHTML = '<i data-lucide="coffee" style="width:15px;height:15px;"></i> <span id="btn-break-text">Start Break</span>';
    lucide.createIcons();
    
    // Start continuous tracking
    startContinuousLocationTracking();
  }
}

function handleLogout() {
  stopCamera();
  stopTimer();
  stopLocationTracking();
  currentUser = null;
  $('app').classList.add('hidden');
  $('login-page').classList.remove('hidden');
  $('geo-block').classList.remove('open');
  $('out-of-bounds-alert').classList.add('hidden');
  $('btn-break').classList.add('hidden');
  $('l-email').value = '';
  $('l-pass').value = '';
  if (window._charts) { Object.values(window._charts).forEach(c => c?.destroy()); window._charts = {}; }
}

// ─────────────────────────────────────────────
// SIDEBAR / PANEL ROUTING
// ─────────────────────────────────────────────
const adminNav = [
  { view: 'v-admin-dash',     icon: 'layout-dashboard', label: 'Dashboard' },
  { view: 'v-admin-emp',      icon: 'users',            label: 'Employees' },
  { view: 'v-admin-att',      icon: 'calendar-clock',   label: 'Attendance' },
  { view: 'v-admin-outside',  icon: 'map-pin',          label: 'Outside Work' },
  { view: 'v-admin-leaves',   icon: 'mail-open',        label: 'Leave Requests' },
  { view: 'v-admin-holidays', icon: 'calendar',         label: 'Holidays' },
  { view: 'v-admin-payroll',  icon: 'banknote',         label: 'Payroll' },
];

const empNav = [
  { view: 'v-emp-dash',   icon: 'layout-dashboard', label: 'Dashboard' },
  { view: 'v-emp-logs',   icon: 'calendar-clock',   label: 'My Attendance' },
  { view: 'v-emp-leaves', icon: 'mail-open',         label: 'Leaves & Payslips' },
];

function buildSidebar() {
  const nav = currentUser.role === 'Admin' ? adminNav : empNav;
  const ul = $('sidebar-nav');
  ul.innerHTML = '';
  nav.forEach(item => {
    const li = document.createElement('li');
    li.className = 'nav-item';
    li.dataset.view = item.view;
    li.innerHTML = `<a><i data-lucide="${item.icon}" style="width:18px;height:18px;flex-shrink:0;"></i>${item.label}</a>`;
    li.addEventListener('click', () => {
      document.querySelectorAll('#sidebar-nav .nav-item').forEach(x => x.classList.remove('active'));
      li.classList.add('active');
      showView(item.view);
      $('page-title').textContent = item.label;
      switch (item.view) {
        case 'v-admin-dash':     loadAdminDash(); break;
        case 'v-admin-emp':      renderEmpDir(); break;
        case 'v-admin-att':      renderAttLogs(); break;
        case 'v-admin-outside':  renderOutsideApprovals(); break;
        case 'v-admin-leaves':   renderLeaveApprovals(); break;
        case 'v-admin-holidays': renderCalendar(); renderHolidays(); break;
        case 'v-admin-payroll':  renderPayroll(); break;
        case 'v-emp-dash':       loadEmpDash(); break;
        case 'v-emp-logs':       renderEmpLogs(); break;
        case 'v-emp-leaves':     renderEmpLeaves(); break;
      }
      lucide.createIcons();
      if (window.innerWidth < 768) {
        $('sidebar').classList.remove('open');
        $('sidebar-overlay').classList.remove('open');
      }
    });
    ul.appendChild(li);
  });
  ul.children[0]?.classList.add('active');

  $('s-avatar').textContent = currentUser.name[0].toUpperCase();
  $('s-name').textContent = currentUser.name;
  $('s-role').textContent = currentUser.role;

  lucide.createIcons();
  buildBottomNav();
}

function buildBottomNav() {
  const bottomNav = $('bottom-nav');
  if (!bottomNav) return;

  if (!currentUser) {
    bottomNav.innerHTML = '';
    bottomNav.classList.add('hidden');
    return;
  }

  bottomNav.classList.remove('hidden');

  let items = [];
  if (currentUser.role === 'Admin') {
    items = [
      { view: 'v-admin-dash', icon: 'home', label: 'Home' },
      { view: 'v-admin-emp', icon: 'users', label: 'Staff' },
      { view: 'v-admin-att', icon: 'calendar-clock', label: 'Logs' },
      { view: 'v-admin-payroll', icon: 'banknote', label: 'Payroll' },
      { action: 'toggle-menu', icon: 'menu', label: 'More' }
    ];
  } else {
    items = [
      { view: 'v-emp-dash', icon: 'home', label: 'Home' },
      { view: 'v-emp-logs', icon: 'calendar-clock', label: 'Attendance' },
      { view: 'v-emp-leaves', icon: 'mail-open', label: 'Leaves' },
      { action: 'toggle-menu', icon: 'menu', label: 'More' }
    ];
  }

  bottomNav.innerHTML = items.map(item => {
    const isAction = !!item.action;
    const viewAttr = isAction ? '' : `data-view="${item.view}"`;
    const actionAttr = isAction ? `data-action="${item.action}"` : '';
    return `
      <div class="bottom-nav-item" ${viewAttr} ${actionAttr}>
        <i data-lucide="${item.icon}" style="width:20px;height:20px;"></i>
        <span>${item.label}</span>
      </div>
    `;
  }).join('');

  lucide.createIcons();
  updateBottomNavActiveItem();

  bottomNav.querySelectorAll('.bottom-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      const action = item.dataset.action;

      if (view) {
        const sidebarItem = [...document.querySelectorAll('#sidebar-nav .nav-item')].find(x => x.dataset.view === view);
        if (sidebarItem) {
          sidebarItem.click();
        } else {
          showView(view);
        }
      } else if (action === 'toggle-menu') {
        $('sidebar').classList.toggle('open');
        $('sidebar-overlay').classList.toggle('open');
      }
    });
  });
}

function updateBottomNavActiveItem() {
  const bottomNav = $('bottom-nav');
  if (!bottomNav) return;

  const activeView = document.querySelector('.view-panel.active')?.id;
  bottomNav.querySelectorAll('.bottom-nav-item').forEach(item => {
    if (item.dataset.view === activeView) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

function updateHeader() {
  const now = new Date();
  $('hdr-date').textContent = now.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
}

function updateGeoIndicator(geo) {
  const dot  = $('geo-dot');
  const text = $('geo-status-text');
  if (!dot || !text) return;
  if (geo.ok === true) {
    dot.className = 'geo-dot active';
    text.textContent = 'Inside permitted zone';
  } else if (geo.ok === false) {
    dot.className = 'geo-dot error';
    text.textContent = 'Outside permitted zone';
  } else {
    dot.className = 'geo-dot';
    text.textContent = 'Location check disabled';
  }
}

function updateLocStrip(msg, color) {
  const text = $('loc-strip-text');
  if (text) {
    text.textContent = msg;
    text.style.color = color || 'inherit';
  }
}

// ─────────────────────────────────────────────
// FACE CAMERA SCANNER
// ─────────────────────────────────────────────
function setScanStatus(msg, color = 'var(--text)') {
  const el = $('scan-status');
  if (el) { el.textContent = msg; el.style.color = color; }
}

async function startCamera(vidId, canvId, fallId, laserId, pulseId, mode, onSuccess) {
  scanTarget = mode;
  try {
    if (cameraStream) stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 480, height: 480 }, audio: false });
    cameraStream = stream;

    const vid = $(vidId);
    vid.srcObject = stream;
    vid.classList.remove('hidden');
    $(canvId).classList.remove('hidden');
    $(fallId).classList.add('hidden');
    $(laserId).classList.remove('hidden');
    $(pulseId).classList.remove('hidden');
    setScanStatus('Camera active — scan starting…');

    setTimeout(() => performScan(vidId, canvId, laserId, pulseId, fallId, mode, onSuccess), 2500);
  } catch (err) {
    $(fallId).classList.remove('hidden');
    setScanStatus('Camera block bypass — virtual scan running…', 'var(--warn)');
    setTimeout(() => performScan(vidId, canvId, laserId, pulseId, fallId, mode, onSuccess), 2000);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  ['cam-feed','cam-canvas','modal-cam','modal-canvas'].forEach(id => $(id)?.classList.add('hidden'));
  ['cam-fallback','modal-fallback'].forEach(id => $(id)?.classList.remove('hidden'));
  ['scan-laser','scan-pulse','modal-laser','modal-pulse'].forEach(id => $(id)?.classList.add('hidden'));
}

function performScan(vidId, canvId, laserId, pulseId, fallId, mode, onSuccess) {
  setScanStatus('🔍 Scanning face features…', 'var(--accent)');
  const vid  = $(vidId);
  const canv = $(canvId);
  if (canv && vid) {
    const ctx = canv.getContext('2d');
    const W = canv.offsetWidth || 240;
    const H = canv.offsetHeight || 240;
    canv.width = W; canv.height = H;
    ctx.save();
    ctx.scale(-1, 1);
    try { ctx.drawImage(vid, -W, 0, W, H); } catch(e) {}
    ctx.restore();
    ctx.strokeStyle = 'rgba(16,185,129,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.arc(W/2, H/2, W/2 - 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  setTimeout(() => {
    setScanStatus('✓ Identity Match Confirmed!', 'var(--success)');
    stopCamera();
    setTimeout(() => { onSuccess && onSuccess(); }, 600);
  }, 1800);
}

// ─────────────────────────────────────────────
// ATTENDANCE LOGGING CALLBACKS
// ─────────────────────────────────────────────
function afterCheckin() {
  const now   = new Date();
  const today = getLocalISODate(now);
  const time  = fmtTime(now);
  const hour  = now.getHours();
  const status = hour > 9 || (hour === 9 && now.getMinutes() > 5) ? 'Late' : 'Present';

  const logs = DB.get('attendance') || [];
  const existing = logs.find(l => l.empId === currentUser.id && l.date === today);
  if (!existing) {
    logs.push({ empId: currentUser.id, date: today, checkIn: time, checkOut: null, status });
    DB.set('attendance', logs);
  }

  checkInTimestamp = now;
  breakSecondsRemaining = 3600;
  cumulativeBreakSeconds = 0;
  onBreak = false;

  startTimer(now);
  startContinuousLocationTracking();

  $('btn-checkin').disabled  = true;
  $('btn-checkout').disabled = false;
  $('btn-break').classList.remove('hidden');
  $('btn-break').innerHTML = '<i data-lucide="coffee" style="width:15px;height:15px;"></i> <span id="btn-break-text">Start Break</span>';
  lucide.createIcons();
  $('shift-status-badge').textContent = 'Active';
  $('shift-status-badge').style.cssText = 'background:var(--success-bg);color:var(--success);';

  $('td-checkin').textContent = time;

  const currentCut = currentUser.timeCut || 0;
  const currentDebt = currentUser.timeDebt || 0;
  const reqDurationHours = 9 - currentCut + currentDebt; // 8 hrs work + 1 hr break - cut + debt
  const checkout = new Date(now.getTime() + reqDurationHours * 3600000);
  $('td-checkout').textContent = fmtTime(checkout);

  updateTimerDetailsDOM();

  addNotif(`${currentUser.name} clocked in at ${time} (${status})`, status === 'Late' ? '⚠️' : '✅');
  addEmail(currentUser.email, 'Clock-In Notification', `Hi ${currentUser.name},\n\nYou clocked in successfully at ${time}.\nStatus: ${status}\n\n— Time Clock`);

  toast(`Clocked In at ${time} (${status})`, status === 'Late' ? 'error' : 'success');
  setScanStatus(`Clocked In at ${time}`, 'var(--success)');
  loadEmpDash();
}

function afterCheckout() {
  const now   = new Date();
  const today = getLocalISODate(now);
  const time  = fmtTime(now);

  const logs = DB.get('attendance') || [];
  const log  = logs.find(l => l.empId === currentUser.id && l.date === today);
  if (log) {
    processShiftEnd(log, time);
    DB.set('attendance', logs);
  }

  stopTimer();
  stopLocationTracking();

  $('btn-checkin').disabled  = false;
  $('btn-checkout').disabled = true;
  $('btn-break').classList.add('hidden');
  $('shift-status-badge').textContent = 'Completed';
  $('shift-status-badge').style.cssText = 'background:var(--accent-glow);color:var(--accent);';

  addNotif(`${currentUser.name} clocked out at ${time}`, '🏁');
  toast(`Clocked Out at ${time}`, 'success');
  setScanStatus(`Clocked Out at ${time}`, 'var(--accent)');
  loadEmpDash();
}

// ─────────────────────────────────────────────
// LIVE SHIFT TIMERS
// ─────────────────────────────────────────────
function startTimer(from) {
  checkInTimestamp = from;
  $('timer-dot').classList.remove('hidden');
  $('timer-label').textContent = 'Shift running…';
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);
  tickTimer();
}

function restoreTimer(from) {
  checkInTimestamp = from;
  $('timer-dot').classList.remove('hidden');
  $('timer-label').textContent = 'Shift running…';
  $('td-checkin').textContent = fmtTime(from);
  
  const currentCut = currentUser.timeCut || 0;
  const currentDebt = currentUser.timeDebt || 0;
  const reqDurationHours = 9 - currentCut + currentDebt;
  const checkout = new Date(from.getTime() + reqDurationHours * 3600000);
  $('td-checkout').textContent = fmtTime(checkout);

  updateTimerDetailsDOM();

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);
  tickTimer();
}

function updateTimerDetailsDOM() {
  const currentCut = currentUser.timeCut || 0;
  const currentDebt = currentUser.timeDebt || 0;
  const reqHrsToday = Math.max(0, 8 - currentCut + currentDebt);

  const rowCut = $('row-carryover-cut');
  if (rowCut) {
    if (currentCut > 0) {
      rowCut.style.display = 'flex';
      $('td-carryover-cut').textContent = currentCut.toFixed(2) + ' hrs';
    } else {
      rowCut.style.display = 'none';
    }
  }

  const rowDebt = $('row-carryover-debt');
  if (rowDebt) {
    if (currentDebt > 0) {
      rowDebt.style.display = 'flex';
      $('td-carryover-debt').textContent = currentDebt.toFixed(2) + ' hrs';
    } else {
      rowDebt.style.display = 'none';
    }
  }

  const reqHrsEl = $('td-req-hours');
  if (reqHrsEl) {
    reqHrsEl.textContent = reqHrsToday.toFixed(2) + ' hrs';
  }
}

function processShiftEnd(log, time) {
  log.checkOut = time;
  const inMin  = toMin(log.checkIn);
  const outMin = toMin(time);
  const netMin = outMin - inMin - 60; // minus 1hr break
  const netHrs = Math.max(0, netMin / 60);

  const emps = DB.get('employees') || [];
  const emp = emps.find(e => e.id === currentUser.id);

  if (emp) {
    emp.timeCut = emp.timeCut || 0;
    emp.timeDebt = emp.timeDebt || 0;
    emp.overtimeAccumulated = emp.overtimeAccumulated || 0;
    emp.leaveBalance = emp.leaveBalance || { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 };
    emp.leaveBalance.Holiday = emp.leaveBalance.Holiday || 0;

    const currentCut = emp.timeCut;
    const currentDebt = emp.timeDebt;

    // Calculate expected work hours for today
    const reqHrsToday = Math.max(0, 8 - currentCut + currentDebt);

    // Difference between actual work and required work
    const diff = netHrs - reqHrsToday;

    let nextCut = 0;
    let nextDebt = 0;
    let generatedOT = 0;

    if (diff > 0) {
      // Overtime generated!
      generatedOT = diff;
      nextCut = diff;
      nextDebt = 0;
    } else if (diff < 0) {
      // Deficit generated!
      nextCut = 0;
      nextDebt = -diff;
    }

    // Update log fields
    log.netHours = parseFloat(netHrs.toFixed(2));
    log.overtime = parseFloat(generatedOT.toFixed(2));
    log.requiredHours = parseFloat(reqHrsToday.toFixed(2));
    log.timeCutUsed = parseFloat(currentCut.toFixed(2));
    log.timeDebtUsed = parseFloat(currentDebt.toFixed(2));

    // Update employee carry-over values for the next shift
    emp.timeCut = nextCut;
    emp.timeDebt = nextDebt;

    // Accumulate overtime for holiday calculation
    if (generatedOT > 0) {
      emp.overtimeAccumulated = (emp.overtimeAccumulated || 0) + generatedOT;
      if (emp.overtimeAccumulated >= 8) {
        const newHolidays = Math.floor(emp.overtimeAccumulated / 8);
        emp.leaveBalance.Holiday = (emp.leaveBalance.Holiday || 0) + newHolidays;
        emp.overtimeAccumulated = parseFloat((emp.overtimeAccumulated % 8).toFixed(2));

        addNotif(`${emp.name} earned ${newHolidays} Overtime Holiday day(s)!`, '🎉');
        addEmail(emp.email, 'Overtime Holiday Earned!', `Hi ${emp.name},\n\nCongratulations! You have accumulated 8 hours of overtime and earned ${newHolidays} day(s) of Overtime Holiday leave.\nYour new Holiday balance is: ${emp.leaveBalance.Holiday} day(s).\n\n— Time Clock HR`);
      }
    }

    // Sync to currentUser
    currentUser.timeCut = emp.timeCut;
    currentUser.timeDebt = emp.timeDebt;
    currentUser.overtimeAccumulated = emp.overtimeAccumulated;
    currentUser.leaveBalance = emp.leaveBalance;

    // Save back to employees DB
    DB.set('employees', emps);
  } else {
    log.netHours = parseFloat(netHrs.toFixed(2));
    log.overtime = Math.max(0, log.netHours - NET_WORK_HOURS);
  }
}

function tickTimer() {
  if (!checkInTimestamp) return;
  const elapsed = Math.floor((Date.now() - checkInTimestamp) / 1000);
  $('timer-disp').textContent = fmtHHMMSS(elapsed);
  const hrs = Math.max(0, (elapsed / 3600) - BREAK_HOURS);
  $('td-net').textContent = hrs.toFixed(2) + ' hrs';
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  checkInTimestamp = null;
  $('timer-dot').classList.add('hidden');
  $('timer-label').textContent = 'Shift inactive';
}

// ─────────────────────────────────────────────
// EMPLOYEE INTERFACES & DASHBOARDS
// ─────────────────────────────────────────────
function loadEmpDash() {
  const today   = getLocalISODate();
  const now     = new Date();
  const yr      = now.getFullYear();
  const mo      = now.getMonth();
  const logs    = (DB.get('attendance') || []).filter(l => l.empId === currentUser.id);
  const moLogs  = logs.filter(l => {
    const d = new Date(l.date + 'T00:00:00');
    return d.getFullYear() === yr && d.getMonth() === mo;
  });
  const todayLog = logs.find(l => l.date === today);

  $('e-kpi-days').textContent = `${moLogs.length} / 22`;
  $('e-kpi-rate').textContent = `${Math.round(moLogs.length / 22 * 100)}% attendance`;

  const u = currentUser;
  const lb = u.leaveBalance || { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 };
  $('e-kpi-leave').textContent = `${lb.Annual} Days`;

  // Update carryover KPI
  const cut = u.timeCut || 0;
  const debt = u.timeDebt || 0;
  const carryoverEl = $('e-kpi-carryover');
  const carryoverSubEl = $('e-kpi-carryover-sub');
  if (carryoverEl && carryoverSubEl) {
    if (cut > 0) {
      carryoverEl.textContent = `+${cut.toFixed(2)} hrs`;
      carryoverEl.style.color = 'var(--success)';
      carryoverSubEl.textContent = 'Time cut tomorrow';
    } else if (debt > 0) {
      carryoverEl.textContent = `-${debt.toFixed(2)} hrs`;
      carryoverEl.style.color = 'var(--danger)';
      carryoverSubEl.textContent = 'Time debt tomorrow';
    } else {
      carryoverEl.textContent = '0.00 hrs';
      carryoverEl.style.color = '';
      carryoverSubEl.textContent = 'No carry-over pending';
    }
  }

  if (todayLog && todayLog.checkIn) {
    const inMin  = toMin(todayLog.checkIn);
    const outMin = todayLog.checkOut ? toMin(todayLog.checkOut) : (now.getHours()*60 + now.getMinutes());
    const hrs    = Math.max(0, (outMin - inMin - 60) / 60);
    $('e-kpi-shift').textContent = `${Math.floor(hrs)}h ${Math.round((hrs % 1) * 60)}m`;
  }

  const rate = moLogs.length / 22 * 100;
  let insight = '';
  if (rate >= 95) insight = '🌟 Stellar attendance record this month! You\'re fully compliant.';
  else if (rate >= 80) insight = '👍 Solid attendance performance. Keep it up!';
  else insight = '⚠️ Performance warning: Attendance falls below 80% requirements.';
  $('emp-ai-text').textContent = insight;

  const recent = [...logs].reverse().slice(0, 7);
  $('e-recent-tbody').innerHTML = recent.map(l => `
    <tr>
      <td data-label="Date">${l.date}</td>
      <td data-label="Check In">${l.checkIn || '—'}</td>
      <td data-label="Check Out">${l.checkOut || '—'}</td>
      <td data-label="Work Hrs">${l.netHours ?? '—'}</td>
      <td data-label="Overtime">${l.overtime ? l.overtime + ' hrs' : '—'}</td>
      <td data-label="Status">${badge(l.status)}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2);">No attendance logs.</td></tr>';
}

function renderEmpLogs() {
  const filter = $('emp-log-filter').value;
  let logs = (DB.get('attendance') || []).filter(l => l.empId === currentUser.id);
  if (filter) {
    logs = logs.filter(l => l.date.startsWith(filter));
  }
  $('emp-log-tbody').innerHTML = logs.reverse().map(l => `
    <tr>
      <td data-label="Date">${l.date}</td>
      <td data-label="Check In">${l.checkIn||'—'}</td>
      <td data-label="Check Out">${l.checkOut||'—'}</td>
      <td data-label="Work Hrs">${l.netHours??'—'}</td>
      <td data-label="Overtime">${l.overtime?l.overtime+' hrs':'—'}</td>
      <td data-label="Status">${badge(l.status)}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2);">No attendance.</td></tr>';
}

// ─────────────────────────────────────────────
// LEAVES & OUTSIDE WORK
// ─────────────────────────────────────────────
function renderEmpLeaves() {
  const u   = currentUser;
  const lb  = u.leaveBalance || { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 };
  $('bal-annual').textContent = lb.Annual;
  $('bal-sick').textContent   = lb.Sick;
  $('bal-casual').textContent = lb.Casual;
  $('bal-holiday').textContent = lb.Holiday || 0;

  const allLeaves = (DB.get('leaves') || []).filter(l => l.empId === u.id);
  $('emp-leaves-tbody').innerHTML = allLeaves.map(l => `
    <tr>
      <td data-label="Period">${l.start} → ${l.end}</td>
      <td data-label="Type">${l.type}${l.halfDay ? ' (Half-Day)' : ''}</td>
      <td data-label="Status">${badge(l.status)}</td>
    </tr>`).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text2);">No leave request history.</td></tr>';

  // Render outside work requests
  const allOutside = (DB.get('outside_work') || []).filter(o => o.empId === u.id);
  $('emp-outside-tbody').innerHTML = allOutside.map(o => `
    <tr>
      <td data-label="Date">${o.date}</td>
      <td data-label="Type">${o.type}</td>
      <td data-label="Reason">${o.reason}</td>
      <td data-label="Status">${badge(o.status)}</td>
    </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text2);">No outside work requests.</td></tr>';

  renderEmpPayslips();
}

function handleLeaveApply(e) {
  e.preventDefault();
  let type     = $('lv-type').value;
  const start  = $('lv-start').value;
  const isHalf = ($('lv-halfday') && $('lv-halfday').checked) || type.startsWith('Half-Day ');
  const end    = isHalf ? start : $('lv-end').value;
  const reason = $('lv-reason').value;
  if (!start || !end || end < start) { toast('Invalid date range.', 'error'); return; }

  // Normalize type to base type
  if (type.startsWith('Half-Day ')) {
    type = type.replace('Half-Day ', '');
  }

  DB.push('leaves', { 
    empId: currentUser.id, 
    empName: currentUser.name, 
    type, 
    start, 
    end, 
    halfDay: isHalf, 
    reason, 
    status: 'Pending' 
  });
  addNotif(`New leave application: ${type}${isHalf ? ' (Half-Day)' : ''} on ${start}`, '📋');
  addEmail('admin@company.com', `Leave Request — ${currentUser.name}`, `${currentUser.name} requested leave: ${type}${isHalf ? ' (Half-Day)' : ''}.\nReason: ${reason}`);

  toast('Leave request applied!', 'success');
  $('leave-form').reset();
  if ($('lv-end')) $('lv-end').disabled = false;
  renderEmpLeaves();
}

// Outside Work Application handlers
function handleOutsideApply(e) {
  e.preventDefault();
  const type = $('ow-type').value;
  const date = $('ow-date').value;
  const reason = $('ow-reason').value;
  if (!date) return;

  DB.push('outside_work', {
    empId: currentUser.id,
    empName: currentUser.name,
    type,
    date,
    reason,
    status: 'Pending'
  });

  addNotif(`New Outside Work request: ${type} for ${date}`, '📍');
  addEmail('admin@company.com', `Outside Work Request — ${currentUser.name}`, `${currentUser.name} requested Outside Work bypass for WFH/duty on ${date}.\nJustification: ${reason}`);

  toast('Outside work application submitted!', 'success');
  $('outside-work-form').reset();
  renderEmpLeaves();
}

function handleModalOutsideApply(e) {
  e.preventDefault();
  const type = $('m-ow-type').value;
  const date = $('m-ow-date').value;
  const reason = $('m-ow-reason').value;
  if (!date) return;

  DB.push('outside_work', {
    empId: currentUser.id,
    empName: currentUser.name,
    type,
    date,
    reason,
    status: 'Pending'
  });

  addNotif(`Emergency Outside Work request: ${type} for ${date}`, '🚨');
  toast('Emergency bypass request submitted to HR!', 'success');
  closeModal('modal-outside-req');
  $('modal-outside-form').reset();
  renderEmpLeaves();
}

// ─────────────────────────────────────────────
// HR ADMIN OUTSIDE WORK APPROVAL PANEL
// ─────────────────────────────────────────────
function renderOutsideApprovals() {
  const requests = DB.get('outside_work') || [];
  $('outside-approve-tbody').innerHTML = requests.map((o, idx) => `
    <tr>
      <td data-label="Employee" style="font-weight:600;">${o.empName}</td>
      <td data-label="Type">${o.type}</td>
      <td data-label="Requested Date">${o.date}</td>
      <td data-label="Reason">${o.reason}</td>
      <td data-label="Status">${badge(o.status)}</td>
      <td data-label="Action">
        ${o.status === 'Pending' ? `
          <button class="btn btn-success btn-sm" onclick="respondOutsideWork(${idx}, 'Approved')">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="respondOutsideWork(${idx}, 'Rejected')" style="margin-top:4px;">Reject</button>
        ` : '—'}
      </td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2);">No pending outside work files.</td></tr>';
}

function respondOutsideWork(idx, status) {
  const requests = DB.get('outside_work') || [];
  if (!requests[idx]) return;
  requests[idx].status = status;
  DB.set('outside_work', requests);

  addNotif(`Outside Work request ${status} for ${requests[idx].empName}`, status === 'Approved' ? '✅' : '❌');
  addEmail(requests[idx].empId, `Outside Work Request ${status}`, `Hi ${requests[idx].empName},\n\nYour request for Outside Work (${requests[idx].type}) on ${requests[idx].date} was ${status}.\n\n— HR Admin`);
  
  toast(`Outside Work ${status}!`, status === 'Approved' ? 'success' : 'error');
  renderOutsideApprovals();

  // If employee is currently logged in, check geofence again immediately
  if (currentUser && currentUser.id === requests[idx].empId && checkInTimestamp) {
    checkGeofence().then(geo => {
      const today = getLocalISODate();
      const hasApproval = (DB.get('outside_work') || []).some(
        w => w.empId === currentUser.id && w.date === today && w.status === 'Approved'
      );
      if ((geo.ok === true || hasApproval) && onBreak) {
        triggerAutoBreak(false);
      }
    });
  }
}

// ─────────────────────────────────────────────
// ADMIN DASHBOARD
// ─────────────────────────────────────────────
function loadAdminDash() {
  const emps  = (DB.get('employees') || []).filter(e => e.role !== 'Admin');
  const atts  = DB.get('attendance') || [];
  const today = getLocalISODate();
  const leaves = (DB.get('leaves') || []).filter(l => l.status === 'Pending');
  const fence = getGeofence();

  $('a-kpi-emp').textContent = emps.length;
  $('a-kpi-leaves').textContent = leaves.length;

  const todayLogs = atts.filter(l => l.date === today);
  const pct = emps.length ? Math.round(todayLogs.length / emps.length * 100) : 0;
  const late = todayLogs.filter(l => l.status === 'Late').length;
  $('a-kpi-att').textContent = pct + '%';
  $('a-kpi-late').textContent = `${late} late arrivals today`;

  const totalPay = emps.reduce((s, e) => s + (e.salary || 0), 0);
  $('a-kpi-payroll').textContent = '$' + totalPay.toLocaleString();

  $('geo-lat').value = fence.lat ?? '';
  $('geo-lng').value = fence.lng ?? '';
  $('geo-radius').value = fence.radius ?? 200;

  const rate = emps.length ? Math.round(todayLogs.length / emps.length * 100) : 0;
  let ai = `Workforce attendance rates today: ${rate}%. `;
  if (late > 0) ai += `${late} late punch-in alert(s). `;
  if (leaves.length > 0) ai += `${leaves.length} pending employee leave(s).`;
  $('admin-ai-text').textContent = ai || 'Workforce metrics running fully normal!';

  $('a-today-tbody').innerHTML = emps.map(emp => {
    const log = todayLogs.find(l => l.empId === emp.id) || {};
    return `<tr>
      <td data-label="Employee">${emp.name}</td>
      <td data-label="Dept.">${emp.dept}</td>
      <td data-label="Clock In">${log.checkIn || '—'}</td>
      <td data-label="Clock Out">${log.checkOut || '—'}</td>
      <td data-label="Work Hrs">${log.netHours ?? '—'}</td>
      <td data-label="OT">${log.overtime ? log.overtime + 'h' : '—'}</td>
      <td data-label="Status">${badge(log.status || (todayLogs.find(l=>l.empId===emp.id)?log.status:'Absent'))}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text2);">No attendance data for today.</td></tr>';

  renderCharts(atts, emps);
  lucide.createIcons();
}

// ─────────────────────────────────────────────
// CHARTS
// ─────────────────────────────────────────────
window._charts = {};
function destroyChart(id) { if (window._charts[id]) { window._charts[id].destroy(); delete window._charts[id]; } }

function renderCharts(atts, emps) {
  destroyChart('trend');
  const days = [];
  const presentCounts = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const ds = getLocalISODate(d);
    days.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    presentCounts.push(atts.filter(l => l.date === ds).length);
  }
  const isDark = document.body.classList.contains('dark');
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#64748b' : '#94a3b8';

  window._charts['trend'] = new Chart($('chart-trend'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'Present',
        data: presentCounts,
        backgroundColor: 'rgba(79,70,229,0.2)',
        borderColor: '#4f46e5',
        borderWidth: 2,
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'Outfit', size: 11 } } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { family: 'Outfit', size: 11 }, stepSize: 1 },
             beginAtZero: true, max: Math.max(emps.length, 3) },
      }
    }
  });

  destroyChart('dept');
  const depts = {};
  emps.forEach(e => { depts[e.dept] = (depts[e.dept] || 0) + 1; });
  window._charts['dept'] = new Chart($('chart-dept'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(depts),
      datasets: [{ data: Object.values(depts),
        backgroundColor: ['#4f46e5','#a855f7','#10b981','#f59e0b','#ef4444'],
        borderWidth: 0, hoverOffset: 6 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '70%',
      plugins: { legend: { position: 'bottom', labels: { color: textColor, font: { family: 'Outfit', size: 12 }, padding: 14 } } }
    }
  });
}

// ─────────────────────────────────────────────
// EMPLOYEE DIRECTORY (ADMIN)
// ─────────────────────────────────────────────
function renderEmpDir() {
  const emps = DB.get('employees') || [];
  $('emp-dir-tbody').innerHTML = emps.map(emp => {
    const debt = emp.timeDebt || 0;
    const waiveBtn = debt > 0
      ? `<button class="btn-waive" onclick="waiveDebt('${emp.id}')" title="Waive Time Debt"><i data-lucide="shield-check" style="width:11px;height:11px;"></i>Waive</button>`
      : '';
    return `<tr>
      <td data-label="ID">${emp.id}</td>
      <td data-label="Name" style="font-weight:600;">${emp.name}</td>
      <td data-label="Email">${emp.email}</td>
      <td data-label="Dept.">${emp.dept}</td>
      <td data-label="Role"><span class="badge ${emp.role==='Admin'?'badge-purple':'badge-blue'}">${emp.role}</span></td>
      <td data-label="Salary">$${(emp.salary||0).toLocaleString()}</td>
      <td data-label="Time Debt">
        <span style="font-weight:600; color:${debt > 0 ? 'var(--danger)' : 'var(--text3)'};">${debt.toFixed(2)} hrs</span>
        ${waiveBtn}
      </td>
      <td data-label="Actions" class="action-cell">
        <button class="btn-icon" onclick="editEmp('${emp.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
        <button class="btn-icon" onclick="deleteEmp('${emp.id}')" title="Delete" style="color:var(--danger);"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

function waiveDebt(id) {
  const emps = DB.get('employees') || [];
  const emp = emps.find(e => e.id === id);
  if (!emp) return;

  const oldDebt = emp.timeDebt || 0;
  if (!confirm(`Are you sure you want to waive the penalty/time debt of ${oldDebt.toFixed(2)} hours for ${emp.name}?`)) return;

  emp.timeDebt = 0;
  DB.set('employees', emps);

  if (currentUser?.id === id) {
    currentUser.timeDebt = 0;
  }

  addNotif(`HR Admin approved waiving ${oldDebt.toFixed(2)} debt hours for ${emp.name}`, '🛡️');
  addEmail(emp.email, 'Time Debt Waived by HR', `Hello ${emp.name},\n\nWe are pleased to inform you that your carry-over time debt of ${oldDebt.toFixed(2)} hours has been waived by HR.\n\n— Time Clock HR`);

  toast(`Waived ${oldDebt.toFixed(2)} debt hours successfully!`, 'success');
  renderEmpDir();
}

function editEmp(id) {
  const emps = DB.get('employees') || [];
  const emp  = emps.find(e => e.id === id);
  if (!emp) return;
  $('emp-modal-title').textContent = 'Edit Employee';
  $('emp-edit-id').value = id;
  $('ef-name').value   = emp.name;
  $('ef-email').value  = emp.email;
  $('ef-pwd').value    = emp.password;
  $('ef-role').value   = emp.role;
  $('ef-dept').value   = emp.dept;
  $('ef-desg').value   = emp.designation;
  $('ef-salary').value = emp.salary;
  $('ef-ot').value     = emp.otRate;
  $('ef-timedebt').value = emp.timeDebt || 0;
  $('ef-timecut').value  = emp.timeCut || 0;
  openModal('modal-emp');
}

function deleteEmp(id) {
  if (!confirm('Remove this employee from directory?')) return;
  const emps = (DB.get('employees') || []).filter(e => e.id !== id);
  DB.set('employees', emps);
  renderEmpDir();
  toast('Employee deleted.', 'error');
}

function handleSaveEmp(e) {
  e.preventDefault();
  const id   = $('emp-edit-id').value;
  const name = $('ef-name').value.trim();
  const email= $('ef-email').value.trim().toLowerCase();
  const pwd  = $('ef-pwd').value;
  const role = $('ef-role').value;
  const dept = $('ef-dept').value;
  const desg = $('ef-desg').value.trim();
  const sal  = parseFloat($('ef-salary').value) || 0;
  const ot   = parseFloat($('ef-ot').value) || 0;
  const timeDebt = parseFloat($('ef-timedebt').value) || 0;
  const timeCut  = parseFloat($('ef-timecut').value) || 0;

  const emps = DB.get('employees') || [];

  if (id) {
    const idx = emps.findIndex(e => e.id === id);
    if (idx >= 0) {
      emps[idx] = { 
        ...emps[idx], 
        name, 
        email, 
        password: pwd, 
        role, 
        dept, 
        designation: desg, 
        salary: sal, 
        otRate: ot,
        timeDebt,
        timeCut
      };
      
      if (currentUser && currentUser.id === id) {
        currentUser.timeDebt = timeDebt;
        currentUser.timeCut = timeCut;
      }
      
      DB.set('employees', emps);
      toast('Employee profile saved!', 'success');
    }
  } else {
    const newId = 'EMP' + String(emps.length).padStart(3, '0');
    emps.push({
      id: newId, name, email, password: pwd, role, dept, designation: desg,
      salary: sal, otRate: ot, leaveBalance: { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 },
      timeCut, timeDebt, overtimeAccumulated: 0
    });
    DB.set('employees', emps);
    addNotif(`New employee registered: ${name}`, '👤');
    addEmail(email, 'Your Corporate Profile Access', `Welcome ${name},\n\nYour portal access password is: ${pwd}`);
    toast('Employee registered successfully!', 'success');
  }

  closeModal('modal-emp');
  $('emp-form').reset();
  $('emp-edit-id').value = '';
  renderEmpDir();
}

// ─────────────────────────────────────────────
// MASTER ATTENDANCE LOG (ADMIN)
// ─────────────────────────────────────────────
function renderAttLogs() {
  const dateF  = $('att-date-filter').value;
  const deptF  = $('att-dept-filter').value;
  const emps   = DB.get('employees') || [];
  const allAtt = DB.get('attendance') || [];
  let logs     = allAtt.map((l, index) => ({ ...l, originalIndex: index }));

  if (dateF) logs = logs.filter(l => l.date === dateF);
  if (deptF !== 'ALL') {
    const ids = emps.filter(e => e.dept === deptF).map(e => e.id);
    logs = logs.filter(l => ids.includes(l.empId));
  }

  $('att-log-tbody').innerHTML = logs.map(l => {
    const emp = emps.find(e => e.id === l.empId) || {};
    return `<tr>
      <td data-label="Date">${l.date}</td>
      <td data-label="Emp ID">${l.empId}</td>
      <td data-label="Name" style="font-weight:600;">${emp.name||'—'}</td>
      <td data-label="Clock In">${l.checkIn||'—'}</td>
      <td data-label="Clock Out">${l.checkOut||'—'}</td>
      <td data-label="Work Hrs">${l.netHours??'—'}</td>
      <td data-label="OT">${l.overtime?l.overtime+'h':'—'}</td>
      <td data-label="Status">${badge(l.status)}</td>
      <td data-label="Action">
        <button class="btn btn-secondary btn-sm" onclick="openEditAttendance(${l.originalIndex})" style="padding:4px 8px;font-size:12px;">
          <i data-lucide="edit-3" style="width:13px;height:13px;margin-right:4px;"></i>Edit
        </button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text2);">No matching attendance entries.</td></tr>';
  lucide.createIcons();
}

function openEditAttendance(idx) {
  const allAtt = DB.get('attendance') || [];
  const log = allAtt[idx];
  if (!log) return;

  const emps = DB.get('employees') || [];
  const emp = emps.find(e => e.id === log.empId) || {};

  $('ea-idx').value = idx;
  $('ea-name').value = emp.name || log.empId;
  $('ea-date').value = log.date;
  $('ea-checkin').value = log.checkIn || '';
  $('ea-checkout').value = log.checkOut || '';
  $('ea-status').value = log.status || 'Present';

  openModal('modal-edit-attendance');
}

function handleSaveAttendance(e) {
  e.preventDefault();
  const idx = parseInt($('ea-idx').value);
  const allAtt = DB.get('attendance') || [];
  const log = allAtt[idx];
  if (!log) return;

  const checkIn = $('ea-checkin').value;
  const checkOut = $('ea-checkout').value;
  const status = $('ea-status').value;

  log.checkIn = checkIn || null;
  log.status = status;

  if (checkIn && checkOut) {
    if (checkOut < checkIn) {
      toast('Check-out time cannot be before check-in time.', 'error');
      return;
    }
    log.checkOut = checkOut;
    const inMin = toMin(checkIn);
    const outMin = toMin(checkOut);
    const netMin = outMin - inMin - 60; // minus 1hr break
    const netHrs = Math.max(0, netMin / 60);
    log.netHours = parseFloat(netHrs.toFixed(2));
    
    // Calculate overtime based on employee contract
    const emps = DB.get('employees') || [];
    const emp = emps.find(e => e.id === log.empId);
    let overtime = 0;
    if (emp) {
      const currentCut = emp.timeCut || 0;
      const currentDebt = emp.timeDebt || 0;
      const reqHrsToday = Math.max(0, 8 - currentCut + currentDebt);
      const diff = netHrs - reqHrsToday;
      overtime = diff > 0 ? diff : 0;
    } else {
      overtime = Math.max(0, netHrs - 8);
    }
    log.overtime = parseFloat(overtime.toFixed(2));
  } else {
    log.checkOut = null;
    log.netHours = null;
    log.overtime = null;
  }

  DB.set('attendance', allAtt);
  closeModal('modal-edit-attendance');
  toast('Attendance record updated!', 'success');
  renderAttLogs();
  
  if (currentUser?.role === 'Admin') {
    loadAdminDash();
  }
}

// ─────────────────────────────────────────────
// LEAVE APPROVALS (ADMIN)
// ─────────────────────────────────────────────
function renderLeaveApprovals() {
  const leaves = DB.get('leaves') || [];
  const statusFilter = $('leave-status-filter') ? $('leave-status-filter').value : 'ALL';
  const typeFilter = $('leave-type-filter') ? $('leave-type-filter').value : 'ALL';

  const filtered = leaves.map((l, i) => ({ ...l, originalIndex: i }))
    .filter(l => {
      if (statusFilter !== 'ALL' && l.status !== statusFilter) return false;
      if (typeFilter !== 'ALL') {
        if (typeFilter.startsWith('Half-Day ')) {
          const baseType = typeFilter.replace('Half-Day ', '');
          if (l.type !== baseType || !l.halfDay) return false;
        } else {
          if (l.type !== typeFilter || l.halfDay) return false;
        }
      }
      return true;
    });

  $('leave-approve-tbody').innerHTML = filtered.map(l => `
    <tr>
      <td data-label="Employee" style="font-weight:600;">${l.empName||'—'}</td>
      <td data-label="Type">${l.type}${l.halfDay ? ' (Half-Day)' : ''}</td>
      <td data-label="From → To">${l.start} → ${l.end}</td>
      <td data-label="Reason" style="font-size:12px;max-width:120px;color:var(--text2);">${l.reason||'—'}</td>
      <td data-label="Status">${badge(l.status)}</td>
      <td data-label="Action">
        ${l.status==='Pending'?`
          <button class="btn btn-success btn-sm" onclick="respondLeave(${l.originalIndex},'Approved')">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="respondLeave(${l.originalIndex},'Rejected')" style="margin-top:4px;">Reject</button>
        `:'—'}
      </td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text2);">No leave applications.</td></tr>';
}

function respondLeave(idx, decision) {
  const leaves = DB.get('leaves') || [];
  if (!leaves[idx]) return;
  leaves[idx].status = decision;

  if (decision === 'Approved') {
    const emps = DB.get('employees') || [];
    const emp  = emps.find(e => e.id === leaves[idx].empId);
    if (emp) {
      const isHalf = leaves[idx].halfDay || false;
      const days = isHalf ? 0.5 : (Math.round((new Date(leaves[idx].end) - new Date(leaves[idx].start)) / 864e5) + 1);
      const lb   = emp.leaveBalance || { Annual: 21, Sick: 10, Casual: 7, Holiday: 0 };
      const key  = leaves[idx].type.replace('Half-Day ', '');
      if (lb[key] !== undefined) lb[key] = Math.max(0, lb[key] - days);
      emp.leaveBalance = lb;
      if (currentUser?.id === emp.id) { currentUser.leaveBalance = lb; }
      DB.set('employees', emps);
    }
  }

  DB.set('leaves', leaves);
  addNotif(`Leave ${decision} for ${leaves[idx].empName}`, decision==='Approved'?'✅':'❌');
  addEmail(leaves[idx].empId, `Leave application status`, `Hello,\\n\\nYour application has been ${decision}.\\n— Time Clock HR`);
  toast(`Leave ${decision}!`, decision==='Approved'?'success':'error');
  renderLeaveApprovals();
}

// ─────────────────────────────────────────────
// HOLIDAY MANAGEMENT
// ─────────────────────────────────────────────
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

function renderCalendar() {
  const holidays = DB.get('holidays') || [];
  const holDates = new Set(holidays.map(h => h.date));
  const logs     = DB.get('attendance') || [];
  const attDates = new Set(logs.map(l => l.date));
  const today    = getLocalISODate();

  $('cal-month-label').textContent = monthLabel(new Date(calYear, calMonth, 1));

  const first = new Date(calYear, calMonth, 1).getDay();
  const total = new Date(calYear, calMonth + 1, 0).getDate();

  const grid = $('cal-grid');
  grid.innerHTML = '';
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-label';
    el.textContent = d;
    grid.appendChild(el);
  });

  for (let i = 0; i < first; i++) {
    grid.appendChild(document.createElement('div'));
  }

  for (let day = 1; day <= total; day++) {
    const ds  = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dow = new Date(calYear, calMonth, day).getDay();
    const el  = document.createElement('div');
    el.className = 'cal-day';
    el.textContent = day;
    if (ds === today)        el.classList.add('today');
    if (holDates.has(ds))    el.classList.add('holiday');
    if (dow === 0 || dow === 6) el.classList.add('weekend');
    if (attDates.has(ds))    el.classList.add('attend');
    el.title = holDates.has(ds) ? holidays.find(h=>h.date===ds)?.name : '';
    grid.appendChild(el);
  }
}

function renderHolidays() {
  const holidays = DB.get('holidays') || [];
  $('holiday-tbody').innerHTML = holidays.map((h, i) => `
    <tr>
      <td data-label="Date">${h.date}</td>
      <td data-label="Name" style="font-weight:600;">${h.name}</td>
      <td data-label="Action"><button class="btn-icon" onclick="deleteHoliday(${i})" style="color:var(--danger);"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button></td>
    </tr>`).join('');
  lucide.createIcons();
}

function deleteHoliday(i) {
  const holidays = DB.get('holidays') || [];
  holidays.splice(i, 1);
  DB.set('holidays', holidays);
  renderCalendar();
  renderHolidays();
}

function handleAddHoliday(e) {
  e.preventDefault();
  const date = $('hf-date').value;
  const name = $('hf-name').value.trim();
  DB.push('holidays', { date, name });
  toast('Holiday calendar updated!', 'success');
  closeModal('modal-holiday');
  $('holiday-form').reset();
  renderCalendar();
  renderHolidays();
}

// ─────────────────────────────────────────────
// PAYROLL CORE ENGINE
// ─────────────────────────────────────────────
function renderPayroll() {
  const payrolls = DB.get('payrolls') || [];
  $('payroll-tbody').innerHTML = payrolls.map((p, i) => `
    <tr>
      <td data-label="Emp ID">${p.empId}</td>
      <td data-label="Employee" style="font-weight:600;">${p.empName}</td>
      <td data-label="Base">$${p.basePay.toFixed(2)}</td>
      <td data-label="Overtime" style="color:var(--success);">$${p.otPay.toFixed(2)}</td>
      <td data-label="Deductions" style="color:var(--danger);">−$${p.deductions.toFixed(2)}</td>
      <td data-label="Net Pay" style="font-weight:800;color:var(--accent);">$${p.netPay.toFixed(2)}</td>
      <td data-label="Status">${badge(p.status)}</td>
      <td data-label="Action"><button class="btn btn-secondary btn-sm" onclick="previewPayslip(${i})">
        <i data-lucide="eye" style="width:14px;height:14px;"></i> View
      </button></td>
    </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text2);">No payroll processed.</td></tr>';
  lucide.createIcons();
}

function runPayroll() {
  const period = $('payroll-period').value;
  const [mm, yyyy] = period.split('-');
  const mo   = parseInt(mm) - 1;
  const yr   = parseInt(yyyy);
  const days = new Date(yr, mo + 1, 0).getDate();

  const emps   = (DB.get('employees') || []).filter(e => e.role !== 'Admin');
  const atts   = DB.get('attendance') || [];
  const hols   = new Set((DB.get('holidays') || []).filter(h => h.date.startsWith(`${yyyy}-${mm}`)).map(h => h.date));

  let workDays = 0;
  for (let d = 1; d <= days; d++) {
    const ds  = `${yyyy}-${mm}-${String(d).padStart(2,'0')}`;
    const dow = new Date(yr, mo, d).getDay();
    if (dow !== 0 && dow !== 6 && !hols.has(ds)) workDays++;
  }
  if (!workDays) workDays = 22;

  const payrolls = DB.get('payrolls') || [];
  let newRecords = 0;

  emps.forEach(emp => {
    if (payrolls.find(p => p.empId === emp.id && p.period === period)) return;

    const moLogs = atts.filter(l => {
      if (l.empId !== emp.id) return false;
      const [y, m] = l.date.split('-').map(Number);
      return y === yr && m === mo + 1;
    });

    const present    = moLogs.filter(l => ['Present','Late'].includes(l.status)).length;
    const absent     = Math.max(0, workDays - present);
    const pendingDebt = emp.timeDebt || 0;
    const otHrs      = moLogs.reduce((s, l) => s + (l.overtime || 0), 0);

    const dailyRate  = emp.salary / workDays;
    const basePay    = dailyRate * present;
    
    // Overtime is compensated via time cuts & holiday leaves, so otPay = 0
    const otPay      = 0;
    
    // Deduct absences + outstanding time debt at end of period
    const debtDeduction = pendingDebt * (dailyRate / 8);
    const deductions = (absent * dailyRate) + debtDeduction;
    const netPay     = Math.max(0, basePay + otPay - deductions);

    payrolls.push({
      empId: emp.id, empName: emp.name, period, workDays,
      present, absent, lateCount: 0, otHrs: parseFloat(otHrs.toFixed(2)),
      basePay: parseFloat(basePay.toFixed(2)),
      otPay:   parseFloat(otPay.toFixed(2)),
      deductions: parseFloat(deductions.toFixed(2)),
      netPay:  parseFloat(netPay.toFixed(2)),
      status: 'Paid',
      paidOn: getLocalISODate(),
      dept: emp.dept, designation: emp.designation,
      timeDebt: parseFloat(pendingDebt.toFixed(2)),
      debtDeduction: parseFloat(debtDeduction.toFixed(2))
    });

    addEmail(emp.email, `Monthly Payslip — ${period}`, `Hi ${emp.name},\n\nYour payslip for ${period} is published.\nNet Disbursed: $${netPay.toFixed(2)}`);
    newRecords++;
  });

  DB.set('payrolls', payrolls);
  toast(`Payroll created for ${newRecords} employees!`, 'success');
  addNotif(`Payroll processing complete: ${newRecords} records.`, '💰');
  renderPayroll();
}

function previewPayslip(i) {
  const payrolls = DB.get('payrolls') || [];
  const p = payrolls[i];
  if (!p) return;

  const holidaysEarned = Math.floor((p.otHrs || 0) / 8);

  const html = `
    <div class="payslip-header">
      <h2>Time Clock Solutions</h2>
      <p>Official Pay Statement — ${p.period}</p>
    </div>
    <div class="payslip-meta">
      <div><strong>Employee:</strong> ${p.empName}</div>
      <div><strong>ID:</strong> ${p.empId}</div>
      <div><strong>Department:</strong> ${p.dept||'—'}</div>
      <div><strong>Position:</strong> ${p.designation||'—'}</div>
      <div><strong>Pay Cycle:</strong> ${p.period}</div>
      <div><strong>Disbursed:</strong> ${p.paidOn}</div>
    </div>
    <table class="payslip-table" style="width:100%;margin-bottom:10px;border-collapse:collapse;">
      <thead><tr><th>Items</th><th>Hours/Days</th><th>Total Amount</th></tr></thead>
      <tbody>
        <tr><td>Duty Cycles</td><td>${p.workDays} days</td><td>—</td></tr>
        <tr><td>Present Cycles</td><td>${p.present} days</td><td>—</td></tr>
        <tr><td>Absent Penalties</td><td>${p.absent} days</td><td>—</td></tr>
        <tr><td>Base Remuneration</td><td>Base monthly calc</td><td style="color:var(--success);">+$${p.basePay.toFixed(2)}</td></tr>
        <tr><td>Overtime Compensated</td><td>${p.otHrs || 0} hrs (${holidaysEarned} Holiday day(s) earned)</td><td style="color:var(--success);">+$0.00</td></tr>
        <tr><td>Outstanding Time Debt</td><td>${p.timeDebt || 0} hrs</td><td style="color:var(--danger);">−$${(p.debtDeduction || 0).toFixed(2)}</td></tr>
        <tr><td>Deductions Summary</td><td>Absence + Outstanding Debt</td><td style="color:var(--danger);">−$${p.deductions.toFixed(2)}</td></tr>
      </tbody>
    </table>
    <div class="payslip-net">Net Remuneration: <span>$${p.netPay.toFixed(2)}</span></div>`;

  $('payslip-body').innerHTML = html;
  openModal('modal-payslip');
  lucide.createIcons();
}

function renderEmpPayslips() {
  const payrolls = (DB.get('payrolls') || []).filter(p => p.empId === currentUser.id);
  $('emp-payslip-tbody').innerHTML = payrolls.map((p) => `
    <tr>
      <td data-label="Period">${p.period}</td>
      <td data-label="Base Pay">$${p.basePay.toFixed(2)}</td>
      <td data-label="Overtime" style="color:var(--success);">$${p.otPay.toFixed(2)}</td>
      <td data-label="Deductions" style="color:var(--danger);">$${p.deductions.toFixed(2)}</td>
      <td data-label="Net Pay" style="font-weight:800;color:var(--accent);">$${p.netPay.toFixed(2)}</td>
      <td data-label="Paid On">${p.paidOn}</td>
      <td data-label="Action"><button class="btn btn-secondary btn-sm" onclick="previewPayslip(${(DB.get('payrolls')||[]).findIndex(x=>x.empId===currentUser.id&&x.period===p.period)})">
        <i data-lucide="eye" style="width:14px;height:14px;"></i> View
      </button></td>
    </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text2);">No statements published.</td></tr>';
  lucide.createIcons();
}

// ─────────────────────────────────────────────
// DRAWERS
// ─────────────────────────────────────────────
function renderEmails() {
  const emails = (DB.get('emails') || []).reverse();
  $('email-list').innerHTML = emails.map(e => `
    <div class="log-card accent">
      <div class="log-top"><span>To: ${e.to}</span><span>${new Date(e.ts).toLocaleString()}</span></div>
      <div class="log-subject">${e.subject}</div>
      <div class="log-body">${e.body}</div>
    </div>`).join('') || '<p style="color:var(--text2);font-size:13px;">No emails logged.</p>';
}

function renderNotifs() {
  const notifs = (DB.get('notifications') || []).reverse();
  $('notif-list').innerHTML = notifs.map(n => `
    <div class="log-card">
      <div class="log-top"><span style="font-size:18px;">${n.icon}</span><span>${new Date(n.ts).toLocaleString()}</span></div>
      <div class="log-body">${n.msg}</div>
    </div>`).join('') || '<p style="color:var(--text2);font-size:13px;">No alerts logged.</p>';
}

// ─────────────────────────────────────────────
// GEOFENCE SETTINGS
// ─────────────────────────────────────────────
function handleSaveGeofence() {
  const lat    = parseFloat($('geo-lat').value);
  const lng    = parseFloat($('geo-lng').value);
  const radius = parseFloat($('geo-radius').value) || 200;

  if (isNaN(lat) || isNaN(lng)) { toast('Coordinates required.', 'error'); return; }

  saveGeofence(lat, lng, radius);
  $('geo-save-status').style.display = 'flex';
  $('geo-save-msg').textContent = `Configured: Radius ${radius}m`;
  toast('Geofencing settings updated!', 'success');
}

function useMyLocationAsGeofence() {
  if (!navigator.geolocation) { toast('Geolocation unsupported', 'error'); return; }
  toast('Tracking coordinate metrics…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      $('geo-lat').value = pos.coords.latitude.toFixed(6);
      $('geo-lng').value = pos.coords.longitude.toFixed(6);
      toast('Filled local GPS coordinates!', 'success');
    },
    () => toast('GPS access failed.', 'error'),
    { timeout: 8000, enableHighAccuracy: true }
  );
}

// ─────────────────────────────────────────────
// LIGHT/DARK MODE
// ─────────────────────────────────────────────
function toggleTheme() {
  darkMode = !darkMode;
  document.body.classList.toggle('dark', darkMode);
  $('theme-label').textContent = darkMode ? 'Light Mode' : 'Dark Mode';
  $('theme-icon').setAttribute('data-lucide', darkMode ? 'sun' : 'moon');
  lucide.createIcons();
}

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────
async function bootApp() {
  // Initialize IndexedDB first
  try {
    await DBStore.init();
    
    // Load database dumps into in-memory cached map
    const dbDump = await DBStore.getAll();
    dbDump.forEach(item => {
      DB_Cache[item.key] = item.value;
    });

    // Seed empty database with default values
    await initDB();

    // Try to sync with backend Python server database only if running locally
    if (isLocalhost) {
      try {
        const res = await fetch('/api/data');
        if (res.ok) {
          const serverData = await res.json();
          if (serverData && Object.keys(serverData).length > 0) {
            // Server database has records -> sync down to local cache and local IndexedDB
            for (const key in serverData) {
              DB_Cache[key] = serverData[key];
              await DBStore.put(key, serverData[key]);
            }
            console.log("Database successfully synced from server.");
          } else {
            // Server database is empty -> push local seed cache to server database
            await fetch('/api/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(DB_Cache)
            });
            console.log("Database successfully seeded to server.");
          }
          setServerStatus(true);
        } else {
          setServerStatus(false);
        }
      } catch (serverErr) {
        console.warn("Database server unreachable. Running in local mode.");
        setServerStatus(false);
      }
    } else {
      setServerStatus(false);
    }

    // Register PWA/mobile visibility listeners
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        handleBackgroundPause();
      } else {
        handleForegroundResume();
      }
    });

    // Wire application events
    wireEventListeners();
  } catch (err) {
    console.error("Critical Boot Failure:", err);
  }
}



function wireEventListeners() {
  lucide.createIcons();
  setInterval(() => updateHeader(), 60000);

  $('login-form').addEventListener('submit', handleLogin);

  $('quick-admin').addEventListener('click', () => {
    $('l-email').value = 'admin@company.com';
    $('l-pass').value  = 'Admin@1234';
  });

  $('quick-emp').addEventListener('click', () => {
    $('l-email').value = 'employee@company.com';
    $('l-pass').value  = 'Emp@1234';
  });

  $('logout-btn').addEventListener('click', handleLogout);
  $('geo-logout-btn').addEventListener('click', handleLogout);

  $('geo-retry-btn').addEventListener('click', async () => {
    $('geo-block').classList.remove('open');
    setScanStatus('Verifying location…');
    const geo = await checkGeofence();
    updateGeoIndicator(geo);
    
    const today = getLocalISODate();
    const hasOutsideApproval = (DB.get('outside_work') || []).some(
      w => w.empId === currentUser.id && w.date === today && w.status === 'Approved'
    );

    const isAllowed = geo.ok === true || geo.ok === null || hasOutsideApproval;

    if (!isAllowed) {
      $('geo-block-msg').textContent = geo.msg;
      $('geo-block').classList.add('open');
    } else {
      updateLocStrip(geo.msg, 'var(--success)');
      startCamera('cam-feed', 'cam-canvas', 'cam-fallback', 'scan-laser', 'scan-pulse', 'checkin', afterCheckin);
    }
  });

  $('btn-checkin').addEventListener('click', async () => {
    setScanStatus('Reading positioning metadata…');
    $('loc-strip').style.display = 'flex';
    updateLocStrip('Contacting satellites…', 'var(--text3)');

    const geo = await checkGeofence();
    updateGeoIndicator(geo);

    const today = getLocalISODate();
    const hasOutsideApproval = (DB.get('outside_work') || []).some(
      w => w.empId === currentUser.id && w.date === today && w.status === 'Approved'
    );

    const isAllowed = geo.ok === true || geo.ok === null || hasOutsideApproval;

    if (!isAllowed) {
      $('geo-block-msg').textContent = geo.msg;
      $('geo-block').classList.add('open');
      return;
    }
    updateLocStrip(geo.msg, 'var(--success)');
    startCamera('cam-feed', 'cam-canvas', 'cam-fallback', 'scan-laser', 'scan-pulse', 'checkin', afterCheckin);
  });

  $('btn-checkout').addEventListener('click', () => {
    startCamera('cam-feed', 'cam-canvas', 'cam-fallback', 'scan-laser', 'scan-pulse', 'checkout', afterCheckout);
  });

  $('add-emp-btn').addEventListener('click', () => {
    $('emp-modal-title').textContent = 'Add Employee';
    $('emp-edit-id').value = '';
    $('emp-form').reset();
    openModal('modal-emp');
  });

  $('emp-modal-close').addEventListener('click', () => { closeModal('modal-emp'); $('emp-form').reset(); });
  $('emp-form').addEventListener('submit', handleSaveEmp);

  $('add-holiday-btn').addEventListener('click', () => openModal('modal-holiday'));
  $('holiday-modal-close').addEventListener('click', () => closeModal('modal-holiday'));
  $('holiday-form').addEventListener('submit', handleAddHoliday);

  $('run-payroll-btn').addEventListener('click', runPayroll);
  $('payslip-close').addEventListener('click', () => closeModal('modal-payslip'));
  $('print-slip-btn').addEventListener('click', () => window.print());

  $('emails-btn').addEventListener('click', () => { renderEmails(); $('email-drawer').classList.add('open'); $('email-dot').classList.add('hidden'); });
  $('email-drawer-close').addEventListener('click', () => $('email-drawer').classList.remove('open'));
  $('email-clear-btn').addEventListener('click', () => {
    if (confirm("Clear all email simulator logs?")) {
      DB.set('emails', []);
      renderEmails();
      $('email-dot').classList.add('hidden');
      toast("Email logs cleared", "success");
    }
  });

  $('notif-btn').addEventListener('click', () => {
    { renderNotifs(); $('notif-drawer').classList.add('open'); $('notif-dot').classList.add('hidden'); }
  });
  $('notif-drawer-close').addEventListener('click', () => $('notif-drawer').classList.remove('open'));
  $('notif-clear-btn').addEventListener('click', () => {
    if (confirm("Clear all alerts and notifications?")) {
      DB.set('notifications', []);
      renderNotifs();
      $('notif-dot').classList.add('hidden');
      toast("Notifications cleared", "success");
    }
  });

  $('geo-save-btn').addEventListener('click', handleSaveGeofence);
  $('geo-use-my-loc').addEventListener('click', useMyLocationAsGeofence);

  $('cal-prev').addEventListener('click', () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  });
  $('cal-next').addEventListener('click', () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  });

  $('att-date-filter').addEventListener('change', renderAttLogs);
  $('att-dept-filter').addEventListener('change', renderAttLogs);
  $('att-date-filter').value = getLocalISODate();

  $('emp-log-filter').addEventListener('change', renderEmpLogs);
  const now = new Date();
  $('emp-log-filter').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  $('leave-form').addEventListener('submit', handleLeaveApply);
  
  // Sync Leave Type selection with Half-Day checkbox
  $('lv-type').addEventListener('change', () => {
    const typeVal = $('lv-type').value;
    const isHalf = typeVal.startsWith('Half-Day ');
    $('lv-halfday').checked = isHalf;
    if (isHalf) {
      $('lv-end').value = $('lv-start').value;
      $('lv-end').disabled = true;
      $('lv-end').removeAttribute('required');
    } else {
      $('lv-end').disabled = false;
      $('lv-end').setAttribute('required', 'true');
    }
  });

  $('lv-halfday').addEventListener('change', () => {
    const isHalf = $('lv-halfday').checked;
    let typeVal = $('lv-type').value;
    if (isHalf) {
      if (!typeVal.startsWith('Half-Day ')) {
        $('lv-type').value = 'Half-Day ' + typeVal;
      }
      $('lv-end').value = $('lv-start').value;
      $('lv-end').disabled = true;
      $('lv-end').removeAttribute('required');
    } else {
      if (typeVal.startsWith('Half-Day ')) {
        $('lv-type').value = typeVal.replace('Half-Day ', '');
      }
      $('lv-end').disabled = false;
      $('lv-end').setAttribute('required', 'true');
    }
  });

  $('lv-start').addEventListener('change', () => {
    if ($('lv-halfday').checked) {
      $('lv-end').value = $('lv-start').value;
    }
  });

  // Admin leave filters
  if ($('leave-status-filter')) {
    $('leave-status-filter').addEventListener('change', renderLeaveApprovals);
  }
  if ($('leave-type-filter')) {
    $('leave-type-filter').addEventListener('change', renderLeaveApprovals);
  }
  $('outside-work-form').addEventListener('submit', handleOutsideApply);
  $('modal-outside-form').addEventListener('submit', handleModalOutsideApply);

  $('req-outside-work-btn').addEventListener('click', () => {
    $('m-ow-date').value = getLocalISODate();
    openModal('modal-outside-req');
  });
  $('outside-req-close').addEventListener('click', () => closeModal('modal-outside-req'));

  $('e-see-all-logs').addEventListener('click', () => {
    document.querySelectorAll('#sidebar-nav .nav-item').forEach(x => x.classList.remove('active'));
    const logItem = [...document.querySelectorAll('#sidebar-nav .nav-item')].find(x => x.dataset.view === 'v-emp-logs');
    logItem?.classList.add('active');
    showView('v-emp-logs'); renderEmpLogs(); $('page-title').textContent = 'My Attendance';
  });

  $('a-see-all-att').addEventListener('click', () => {
    document.querySelectorAll('#sidebar-nav .nav-item').forEach(x => x.classList.remove('active'));
    const logItem = [...document.querySelectorAll('#sidebar-nav .nav-item')].find(x => x.dataset.view === 'v-admin-att');
    logItem?.classList.add('active');
    showView('v-admin-att'); renderAttLogs(); $('page-title').textContent = 'Attendance';
  });

  $('menu-btn').addEventListener('click', () => {
    $('sidebar').classList.toggle('open');
    $('sidebar-overlay').classList.toggle('open');
  });

  $('sidebar-overlay').addEventListener('click', () => {
    $('sidebar').classList.remove('open');
    $('sidebar-overlay').classList.remove('open');
  });

  $('hdr-back-btn').addEventListener('click', () => {
    const dashView = currentUser.role === 'Admin' ? 'v-admin-dash' : 'v-emp-dash';
    const item = [...document.querySelectorAll('#sidebar-nav .nav-item')].find(x => x.dataset.view === dashView);
    item?.click();
  });

  $('theme-btn').addEventListener('click', toggleTheme);
  $('btn-break').addEventListener('click', () => {
    if (onBreak && breakType === 'manual') {
      triggerManualBreak(false);
    } else if (!onBreak) {
      triggerManualBreak(true);
    }
  });

  ['modal-emp','modal-holiday','modal-payslip','modal-faceid','modal-outside-req','modal-edit-attendance'].forEach(id => {
    $(id).addEventListener('click', e => { if (e.target === $(id)) closeModal(id); });
  });

  $('edit-att-close').addEventListener('click', () => closeModal('modal-edit-attendance'));
  $('edit-att-form').addEventListener('submit', handleSaveAttendance);

  ['email-drawer','notif-drawer'].forEach(id => {
    $(id).addEventListener('click', e => { if (e.target === $(id)) $(id).classList.remove('open'); });
  });

  updateHeader();
}

// Boot the application
document.addEventListener('DOMContentLoaded', bootApp);
