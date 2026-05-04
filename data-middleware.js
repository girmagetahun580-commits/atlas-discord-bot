import process from 'process';

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

function authHeaders() {
  return {
    'Authorization': `Bearer ${API_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed with status ${res.status}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed with status ${res.status}`);
  }
  return res.json();
}

export function detectIntent(message) {
  const lower = message.toLowerCase();
  const intents = new Set();
  const extractedParams = {};

  if (/\b(add task|new task|create task)\b/.test(lower)) {
    intents.add('add_task');
    const nameMatch = message.match(/(?:add task|new task|create task)[:\s]+(.+?)(?:\s+by\s+|\s+due\s+|\s+for\s+|\s+priority\s+|$)/i);
    if (nameMatch) extractedParams.taskName = nameMatch[1].trim();
    const priorityMatch = lower.match(/\b(priority|pri)\s*[:\s]*(high|medium|low|\d+)/);
    if (priorityMatch) extractedParams.priority = priorityMatch[2];
    const dueMatch = message.match(/\b(?:by|due)[:\s]+([^\s,]+(?:\s+[^\s,]+)?)/i);
    if (dueMatch) extractedParams.dueDate = dueMatch[1].trim();
    const projectMatch = message.match(/\bfor\s+(?:project\s+)?([^\s,]+)/i);
    if (projectMatch) extractedParams.project = projectMatch[1].trim();
  }

  if (/\b(complete task|done with|finished|mark done)\b/.test(lower)) {
    intents.add('complete_task');
    const nameMatch = message.match(/(?:complete task|done with|finished|mark done)[:\s]+(.+?)(?:\s*$)/i);
    if (nameMatch) extractedParams.taskName = (extractedParams.taskName || nameMatch[1].trim());
  }

  if (/\b(complete habit|did my|finished my)\b/.test(lower)) {
    intents.add('complete_habit');
    const nameMatch = message.match(/(?:complete habit|did my|finished my)[:\s]+(.+?)(?:\s*$)/i);
    if (nameMatch) extractedParams.habitName = nameMatch[1].trim();
  }

  if (/\b(spent|bought|paid|log expense)\b/.test(lower)) {
    intents.add('log_expense');
    const amountMatch = message.match(/\$?([\d]+(?:\.\d{1,2})?)\s*(?:dollars?)?/i);
    if (amountMatch) extractedParams.amount = parseFloat(amountMatch[1]);
    const vendorMatch = message.match(/(?:\bat\b|\bfrom\b|\bto\b)\s+([A-Za-z0-9 &']+?)(?:\s+for\s+|\s+\$|\s+\d|\s*$)/i);
    if (vendorMatch) extractedParams.vendor = vendorMatch[1].trim();
    const categoryMatch = message.match(/\bfor\s+([A-Za-z]+)\b/i);
    if (categoryMatch) extractedParams.category = categoryMatch[1].trim();
  }

  if (/\b(tasks?|to[\s-]?do|todo|what should i)\b/.test(lower)) intents.add('tasks');
  if (/\b(habits?|workout|meditate|meditating|reading|water|journal|phone before bed)\b/.test(lower)) intents.add('habits');
  if (/\b(bills?|finance|money|spend|expense|budget)\b/.test(lower)) intents.add('finance');
  if (/\b(weather|temperature|rain|hot|cold)\b/.test(lower)) intents.add('weather');
  if (/\b(briefing|brief me|morning|what'?s up|how'?s my day|summary|overview)\b/.test(lower)) intents.add('briefing');

  let finalIntents = [...intents];
  if (finalIntents.includes('briefing')) {
    finalIntents = finalIntents.filter(i => !['tasks', 'habits', 'finance', 'weather'].includes(i));
  }

  return { intents: finalIntents, extractedParams };
}

export async function fetchDataForIntents(intents, params = {}) {
  const sections = [];

  for (const intent of intents) {
    switch (intent) {
      case 'tasks': {
        try {
          const data = await apiGet('/api/tasks');
          const tasks = Array.isArray(data) ? data : data.tasks ?? [];
          if (tasks.length === 0) {
            sections.push('### Active Tasks\nNo active tasks found.');
          } else {
            const lines = tasks.map((t, i) => {
              const parts = [`${i + 1}. ${t.name}`];
              if (t.priority != null) parts.push(`priority: ${t.priority}`);
              if (t.due_date) parts.push(`due: ${t.due_date}`);
              if (t.project) parts.push(`project: ${t.project}`);
              return parts.join(' | ');
            });
            sections.push(`### Active Tasks\n${lines.join('\n')}`);
          }
        } catch (err) {
          sections.push(`### Active Tasks\n[Error fetching tasks: ${err.message}]`);
        }
        break;
      }
      case 'habits': {
        try {
          const data = await apiGet('/api/habits');
          const habits = Array.isArray(data) ? data : data.habits ?? [];
          if (habits.length === 0) {
            sections.push("### Today's Habits\nNo habits found.");
          } else {
            const lines = habits.map(h => `- ${h.name}: ${h.todayDone ? 'done' : 'pending'} (streak: ${h.streak})`);
            sections.push(`### Today's Habits\n${lines.join('\n')}`);
          }
        } catch (err) {
          sections.push(`### Today's Habits\n[Error fetching habits: ${err.message}]`);
        }
        break;
      }
      case 'finance': {
        try {
          const data = await apiGet('/api/finance/bills');
          const bills = Array.isArray(data) ? data : data.bills ?? [];
          const lines = bills.map(b => `- ${b.vendor}: $${b.amount || 0} (${b.category || 'misc'})`);
          sections.push(`### Recurring Bills\n${lines.join('\n')}\nTotal monthly: $${data.total_monthly || 0}`);
        } catch (err) {
          sections.push(`### Recurring Bills\n[Error fetching bills: ${err.message}]`);
        }
        break;
      }
      case 'weather': {
        try {
          const data = await apiGet('/api/weather');
          sections.push(`### Current Weather\n${data.location}: ${data.temperature}, ${data.condition}, Humidity: ${data.humidity}, Wind: ${data.wind}`);
        } catch (err) {
          sections.push(`### Current Weather\n[Error fetching weather: ${err.message}]`);
        }
        break;
      }
      case 'briefing': {
        try {
          const data = await apiGet('/api/briefing');
          sections.push(`### Daily Briefing\n${JSON.stringify(data, null, 2)}`);
        } catch (err) {
          sections.push(`### Daily Briefing\n[Error fetching briefing: ${err.message}]`);
        }
        break;
      }
      case 'add_task': {
        if (!params.taskName) { sections.push('### Add Task\n[Could not extract task name]'); break; }
        try {
          const body = { name: params.taskName };
          if (params.priority) body.priority = params.priority;
          if (params.dueDate) body.due_date = params.dueDate;
          if (params.project) body.project = params.project;
          const data = await apiPost('/api/tasks', body);
          sections.push(`### Add Task\n${data.message || 'Task added.'}`);
        } catch (err) {
          sections.push(`### Add Task\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'complete_task': {
        if (!params.taskName) { sections.push('### Complete Task\n[Could not extract task name]'); break; }
        try {
          const data = await apiPost('/api/tasks/complete', { name: params.taskName });
          sections.push(`### Complete Task\n${data.message || 'Task completed.'}`);
        } catch (err) {
          sections.push(`### Complete Task\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'complete_habit': {
        if (!params.habitName) { sections.push('### Complete Habit\n[Could not extract habit name]'); break; }
        try {
          const data = await apiPost('/api/habits/complete', { name: params.habitName });
          sections.push(`### Complete Habit\n${data.message || 'Habit completed.'}`);
        } catch (err) {
          sections.push(`### Complete Habit\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'log_expense': {
        if (!params.vendor || params.amount == null) { sections.push('### Log Expense\n[Missing vendor or amount]'); break; }
        try {
          const data = await apiPost('/api/finance/add', { vendor: params.vendor, amount: params.amount, category: params.category });
          sections.push(`### Log Expense\n${data.message || 'Expense logged.'}`);
        } catch (err) {
          sections.push(`### Log Expense\n[Error: ${err.message}]`);
        }
        break;
      }
      default: break;
    }
  }

  if (sections.length === 0) return '';
  return ['--- LIVE CONTEXT DATA ---', sections.join('\n\n'), '--- END LIVE CONTEXT DATA ---'].join('\n');
}
