// Atlas API — Server Tools for ElevenLabs ConvAI
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const DATA_DIR = './data';
const API_KEY = process.env.API_SECRET_KEY || 'atlas-default-key';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);

function loadJSON(file) {
  const path = `${DATA_DIR}/${file}`;
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveJSON(file, data) {
  writeFileSync(`${DATA_DIR}/${file}`, JSON.stringify(data, null, 2));
}

function initData() {
  if (!existsSync(`${DATA_DIR}/tasks.json`)) {
    saveJSON('tasks.json', [
      { id: 1, name: "Set up Airtable connection", status: "todo", priority: 4, due_date: "2026-05-01", project: "Atlas Setup" },
      { id: 2, name: "Connect Gmail & Google Calendar", status: "todo", priority: 5, due_date: "2026-05-01", project: "Atlas Setup" },
      { id: 3, name: "Update bill amounts", status: "todo", priority: 4, due_date: "2026-05-02", project: "Atlas Setup" },
    ]);
  }
  if (!existsSync(`${DATA_DIR}/habits.json`)) {
    saveJSON('habits.json', [
      { id: 1, name: "Morning Workout", window: "morning", streak: 0, todayDone: false },
      { id: 2, name: "Read 30 Minutes", window: "evening", streak: 0, todayDone: false },
      { id: 3, name: "Meditate 10 Minutes", window: "morning", streak: 0, todayDone: false },
      { id: 4, name: "Drink 8 Glasses of Water", window: "anytime", streak: 0, todayDone: false },
      { id: 5, name: "Journal Entry", window: "evening", streak: 0, todayDone: false },
      { id: 6, name: "No Phone Before Bed", window: "evening", streak: 0, todayDone: false },
    ]);
  }
  if (!existsSync(`${DATA_DIR}/finance.json`)) {
    saveJSON('finance.json', [
      { id: 1, vendor: "Rent / Mortgage", amount: 0, category: "housing", recurring: true, due_day: 1 },
      { id: 2, vendor: "Netflix", amount: 15.99, category: "subscriptions", recurring: true, due_day: 5 },
      { id: 3, vendor: "Spotify", amount: 10.99, category: "subscriptions", recurring: true, due_day: 5 },
      { id: 4, vendor: "Internet", amount: 0, category: "utilities", recurring: true, due_day: 10 },
      { id: 5, vendor: "Electric Bill", amount: 0, category: "utilities", recurring: true, due_day: 15 },
      { id: 6, vendor: "Car Insurance", amount: 0, category: "transport", recurring: true, due_day: 15 },
      { id: 7, vendor: "Phone Bill", amount: 0, category: "utilities", recurring: true, due_day: 20 },
      { id: 8, vendor: "Gym Membership", amount: 0, category: "health", recurring: true, due_day: 1 },
    ]);
  }
  if (!existsSync(`${DATA_DIR}/expenses.json`)) {
    saveJSON('expenses.json', []);
  }
}

initData();

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

export async function handleAPIRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return true; }
  if (!path.startsWith('/api/')) return false;
  if (!checkAuth(req, res)) return true;

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (path === '/api/tasks' && method === 'GET') {
    const tasks = loadJSON('tasks.json');
    const active = tasks.filter(t => t.status !== 'done').sort((a, b) => b.priority - a.priority);
    json({ tasks: active, total: tasks.length, active: active.length });
    return true;
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = await parseBody(req);
    const tasks = loadJSON('tasks.json');
    const newTask = {
      id: tasks.length + 1, name: body.name || 'Untitled task',
      status: 'todo', priority: body.priority || 3,
      due_date: body.due_date || null, project: body.project || 'General',
      created: new Date().toISOString(),
    };
    tasks.push(newTask);
    saveJSON('tasks.json', tasks);
    json({ message: `Task added: "${newTask.name}"`, task: newTask });
    return true;
  }

  if (path === '/api/tasks/complete' && method === 'POST') {
    const body = await parseBody(req);
    const tasks = loadJSON('tasks.json');
    const task = tasks.find(t => t.name.toLowerCase().includes((body.name || '').toLowerCase()) && t.status !== 'done');
    if (task) {
      task.status = 'done'; task.completed_at = new Date().toISOString();
      saveJSON('tasks.json', tasks);
      json({ message: `Task completed: "${task.name}"` });
    } else {
      json({ message: `No active task matching "${body.name}"` }, 404);
    }
    return true;
  }

  if (path === '/api/habits' && method === 'GET') {
    const habits = loadJSON('habits.json');
    json({ habits, completed_today: habits.filter(h => h.todayDone).length, total: habits.length });
    return true;
  }

  if (path === '/api/habits/complete' && method === 'POST') {
    const body = await parseBody(req);
    const habits = loadJSON('habits.json');
    const habit = habits.find(h => h.name.toLowerCase().includes((body.name || '').toLowerCase()));
    if (habit) {
      habit.todayDone = true; habit.streak += 1;
      saveJSON('habits.json', habits);
      json({ message: `"${habit.name}" marked done! Streak: ${habit.streak} days` });
    } else {
      json({ message: `No habit matching "${body.name}"` }, 404);
    }
    return true;
  }

  if (path === '/api/finance/bills' && method === 'GET') {
    const bills = loadJSON('finance.json');
    json({ bills, total_monthly: bills.reduce((s, b) => s + (b.amount || 0), 0) });
    return true;
  }

  if (path === '/api/finance/add' && method === 'POST') {
    const body = await parseBody(req);
    const expenses = loadJSON('expenses.json');
    const expense = {
      id: expenses.length + 1, vendor: body.vendor || 'Unknown',
      amount: body.amount || 0, category: body.category || 'other',
      date: new Date().toISOString().split('T')[0],
    };
    expenses.push(expense);
    saveJSON('expenses.json', expenses);
    json({ message: `Expense logged: ${expense.amount} at ${expense.vendor}`, expense });
    return true;
  }

  if (path === '/api/finance/spending' && method === 'GET') {
    const expenses = loadJSON('expenses.json');
    const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const byCategory = {};
    expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
    json({ expenses: expenses.slice(-10), total, by_category: byCategory });
    return true;
  }

  if (path === '/api/weather' && method === 'GET') {
    json(await getWeather());
    return true;
  }

  if (path === '/api/briefing' && method === 'GET') {
    const tasks = loadJSON('tasks.json').filter(t => t.status !== 'done').sort((a, b) => b.priority - a.priority).slice(0, 3);
    const habits = loadJSON('habits.json');
    const weather = await getWeather();
    const bills = loadJSON('finance.json');
    const today = new Date().getDate();
    const upcoming = bills.filter(b => b.due_day >= today && b.due_day <= today + 7);
    json({
      top_tasks: tasks.map(t => `${t.name} (priority ${t.priority})`),
      habits: `${habits.filter(h => h.todayDone).length}/${habits.length} done`,
      weather: weather.error ? 'unavailable' : `${weather.temperature}, ${weather.condition}`,
      upcoming_bills: upcoming.map(b => `${b.vendor} due on the ${b.due_day}th`),
    });
    return true;
  }

  json({ error: 'Not found', endpoints: ['/api/tasks', '/api/habits', '/api/finance/bills', '/api/finance/add', '/api/finance/spending', '/api/weather', '/api/briefing'] }, 404);
  return true;
}
