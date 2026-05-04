// Atlas API — Airtable Backend (replaces local JSON storage)
// All data now reads/writes from shared Airtable base
import { isGoogleConfigured, getCalendarEvents, getEmails, getEmailStats, getAuthUrl, exchangeCodeForTokens } from './google.js';

const API_KEY = process.env.API_SECRET_KEY || 'atlas-default-key';
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const AIRTABLE_BASE_ID = 'appinEEtxuzaHbI6J';
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

// --- Airtable helpers ---

async function airtableFetch(path, options = {}) {
  if (!AIRTABLE_PAT) throw new Error('AIRTABLE_PAT not set');
  const res = await fetch(`${AIRTABLE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable ${res.status}: ${body}`);
  }
  return res.json();
}

async function listRecords(table, params = {}) {
  const records = [];
  let offset;
  do {
    const qs = new URLSearchParams(params);
    if (offset) qs.set('offset', offset);
    const data = await airtableFetch(`/${encodeURIComponent(table)}?${qs}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// --- Auth & body parsing (unchanged) ---

function checkAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// --- Weather (unchanged — uses wttr.in) ---

async function getWeather() {
  try {
    const res = await fetch('https://wttr.in/Jinka+Ethiopia?format=j1');
    const data = await res.json();
    const current = data.current_condition[0];
    return {
      location: "Jinka, Ethiopia",
      temperature: `${current.temp_C}\u00b0C`,
      feels_like: `${current.FeelsLikeC}\u00b0C`,
      condition: current.weatherDesc[0].value,
      humidity: `${current.humidity}%`,
      wind: `${current.windspeedKmph} km/h`,
    };
  } catch (err) {
    return { error: "Weather unavailable", details: err.message };
  }
}

// --- Main request handler ---

export async function handleAPIRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return true; }
  if (!path.startsWith('/api/')) return false;

  // Auth bypass for Google OAuth routes
  const noAuthPaths = ['/api/google/auth', '/api/google/callback'];
  if (!noAuthPaths.includes(path) && !checkAuth(req, res)) return true;

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ============ TASKS (Airtable) ============

  if (path === '/api/tasks' && method === 'GET') {
    try {
      const records = await listRecords('Tasks', {
        filterByFormula: "NOT({status} = 'done')",
        'sort[0][field]': 'priority',
        'sort[0][direction]': 'desc',
      });
      const tasks = records.map(r => ({
        id: r.id,
        name: r.fields.name,
        status: r.fields.status || 'todo',
        priority: r.fields.priority || 3,
        due_date: r.fields.due_date || null,
        project: r.fields.project || '',
      }));
      json({ tasks, total: tasks.length, active: tasks.length });
    } catch (err) {
      json({ error: 'Failed to fetch tasks', details: err.message }, 500);
    }
    return true;
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const fields = {
        name: body.name || 'Untitled task',
        status: 'todo',
        priority: body.priority || 3,
        last_touched: new Date().toISOString().slice(0, 10),
      };
      if (body.due_date) fields.due_date = body.due_date;
      if (body.project) fields.project = body.project;

      const data = await airtableFetch(`/${encodeURIComponent('Tasks')}`, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });
      const t = data.records[0];
      json({ message: `Task added: "${t.fields.name}"`, task: t.fields });
    } catch (err) {
      json({ error: 'Failed to add task', details: err.message }, 500);
    }
    return true;
  }

  if (path === '/api/tasks/complete' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const records = await listRecords('Tasks', {
        filterByFormula: "NOT({status} = 'done')",
      });
      const target = records.find(r =>
        r.fields.name.toLowerCase().includes((body.name || '').toLowerCase())
      );
      if (target) {
        await airtableFetch(`/${encodeURIComponent('Tasks')}/${target.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            fields: { status: 'done', last_touched: new Date().toISOString().slice(0, 10) },
            typecast: true,
          }),
        });
        json({ message: `Task completed: "${target.fields.name}"` });
      } else {
        json({ message: `No active task matching "${body.name}"` }, 404);
      }
    } catch (err) {
      json({ error: 'Failed to complete task', details: err.message }, 500);
    }
    return true;
  }

  // ============ HABITS (Airtable) ============

  if (path === '/api/habits' && method === 'GET') {
    try {
      const records = await listRecords('Habits');
      const habits = records.map(r => ({
        id: r.id,
        name: r.fields.habit,
        window: r.fields.target_window || 'anytime',
        streak: r.fields.streak || 0,
        todayDone: r.fields.completed || false,
      }));
      json({ habits, completed_today: habits.filter(h => h.todayDone).length, total: habits.length });
    } catch (err) {
      json({ error: 'Failed to fetch habits', details: err.message }, 500);
    }
    return true;
  }

  if (path === '/api/habits/complete' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const records = await listRecords('Habits');
      const target = records.find(r =>
        r.fields.habit.toLowerCase().includes((body.name || '').toLowerCase())
      );
      if (target) {
        const newStreak = (target.fields.streak || 0) + 1;
        await airtableFetch(`/${encodeURIComponent('Habits')}/${target.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            fields: {
              completed: true,
              date: new Date().toISOString().slice(0, 10),
              streak: newStreak,
            },
            typecast: true,
          }),
        });
        json({ message: `"${target.fields.habit}" marked done! Streak: ${newStreak} days` });
      } else {
        json({ message: `No habit matching "${body.name}"` }, 404);
      }
    } catch (err) {
      json({ error: 'Failed to complete habit', details: err.message }, 500);
    }
    return true;
  }

  // ============ FINANCE (Airtable) ============

  if (path === '/api/finance/bills' && method === 'GET') {
    try {
      const records = await listRecords('Finance', {
        filterByFormula: '{recurring} = TRUE()',
      });
      const bills = records.map(r => ({
        id: r.id,
        vendor: r.fields.vendor,
        amount: r.fields.amount || 0,
        category: r.fields.category || 'misc',
        due_date: r.fields.due_date || null,
      }));
      json({ bills, total_monthly: bills.reduce((s, b) => s + b.amount, 0) });
    } catch (err) {
      json({ error: 'Failed to fetch bills', details: err.message }, 500);
    }
    return true;
  }

  if (path === '/api/finance/add' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const fields = {
        vendor: body.vendor || 'Unknown',
        amount: parseFloat(body.amount) || 0,
        date: new Date().toISOString().slice(0, 10),
        category: body.category || 'misc',
      };
      if (body.notes) fields.notes = body.notes;

      const data = await airtableFetch(`/${encodeURIComponent('Finance')}`, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });
      const e = data.records[0];
      json({ message: `Expense logged: ${e.fields.amount} at ${e.fields.vendor}`, expense: e.fields });
    } catch (err) {
      json({ error: 'Failed to log expense', details: err.message }, 500);
    }
    return true;
  }

  if (path === '/api/finance/spending' && method === 'GET') {
    try {
      const records = await listRecords('Finance', {
        filterByFormula: "NOT({recurring} = TRUE())",
      });
      const expenses = records.map(r => ({
        vendor: r.fields.vendor,
        amount: r.fields.amount || 0,
        category: r.fields.category || 'misc',
        date: r.fields.date || null,
      }));
      const total = expenses.reduce((s, e) => s + e.amount, 0);
      const byCategory = {};
      expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
      json({ expenses: expenses.slice(-10), total, by_category: byCategory });
    } catch (err) {
      json({ error: 'Failed to fetch spending', details: err.message }, 500);
    }
    return true;
  }

  // ============ WEATHER (unchanged) ============

  if (path === '/api/weather' && method === 'GET') {
    json(await getWeather());
    return true;
  }

  // ============ BRIEFING (Airtable) ============

  if (path === '/api/briefing' && method === 'GET') {
    try {
      const [taskRecords, habitRecords, billRecords] = await Promise.all([
        listRecords('Tasks', {
          filterByFormula: "NOT({status} = 'done')",
          'sort[0][field]': 'priority',
          'sort[0][direction]': 'desc',
        }),
        listRecords('Habits'),
        listRecords('Finance', { filterByFormula: '{recurring} = TRUE()' }),
      ]);

      const topTasks = taskRecords.slice(0, 3).map(r => `${r.fields.name} (priority ${r.fields.priority || 3})`);
      const habits = habitRecords;
      const doneCount = habits.filter(r => r.fields.completed).length;
      const weather = await getWeather();
      const upcoming = billRecords
        .filter(r => r.fields.due_date)
        .map(r => ({ vendor: r.fields.vendor, due_date: r.fields.due_date }));

      let calendar = 'not connected';
      let email_stats = 'not connected';
      if (isGoogleConfigured()) {
        try { calendar = await getCalendarEvents(); } catch (err) { calendar = { error: 'Failed', details: err.message }; }
        try {
          const stats = await getEmailStats();
          email_stats = { unread_count: stats.unread_count, urgent_count: stats.urgent_count };
        } catch (err) { email_stats = { error: 'Failed', details: err.message }; }
      }

      json({
        top_tasks: topTasks,
        habits: `${doneCount}/${habits.length} done`,
        weather: weather.error ? 'unavailable' : `${weather.temperature}, ${weather.condition}`,
        upcoming_bills: upcoming,
        calendar,
        email_stats,
      });
    } catch (err) {
      json({ error: 'Briefing failed', details: err.message }, 500);
    }
    return true;
  }

  // ============ GOOGLE CALENDAR & GMAIL (unchanged) ============

  if (path === '/api/calendar' && method === 'GET') {
    if (!isGoogleConfigured()) {
      json({ error: 'Google not configured', setup: 'Visit /api/google/auth to connect' });
      return true;
    }
    const days = parseInt(url.searchParams.get('days') || '1', 10);
    const events = await getCalendarEvents(days);
    json(events);
    return true;
  }

  if (path === '/api/emails' && method === 'GET') {
    if (!isGoogleConfigured()) {
      json({ error: 'Google not configured', setup: 'Visit /api/google/auth to connect' });
      return true;
    }
    const maxResults = parseInt(url.searchParams.get('max') || '10', 10);
    const query = url.searchParams.get('q') || '';
    const emails = await getEmails({ maxResults, query });
    json(emails);
    return true;
  }

  if (path === '/api/emails/stats' && method === 'GET') {
    if (!isGoogleConfigured()) {
      json({ error: 'Google not configured', setup: 'Visit /api/google/auth to connect' });
      return true;
    }
    const stats = await getEmailStats();
    if (stats.error) { json(stats); return true; }
    json({ unread_count: stats.unread_count, urgent_count: stats.urgent_count, oldest_unanswered_hours: stats.oldest_unanswered_hours });
    return true;
  }

  if (path === '/api/google/auth' && method === 'GET') {
    const redirectUri = `https://${req.headers.host}/api/google/callback`;
    const authUrl = getAuthUrl(redirectUri);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return true;
  }

  if (path === '/api/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const redirectUri = `https://${req.headers.host}/api/google/callback`;
    try {
      const tokens = await exchangeCodeForTokens(code, redirectUri);
      const refreshToken = tokens.refresh_token || '(not returned)';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Google Connected</title></head><body><h1>Google Connected!</h1><p>Refresh token: <code>${refreshToken}</code></p><p>Add as GOOGLE_REFRESH_TOKEN in Railway and redeploy.</p></body></html>`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>OAuth Error</h1><pre>${err.message}</pre>`);
    }
    return true;
  }

  // ============ 404 ============

  json({ error: 'Not found', endpoints: ['/api/tasks', '/api/habits', '/api/finance/bills', '/api/finance/add', '/api/finance/spending', '/api/weather', '/api/briefing', '/api/calendar', '/api/emails', '/api/emails/stats', '/api/google/auth', '/api/google/callback'] }, 404);
  return true;
}
