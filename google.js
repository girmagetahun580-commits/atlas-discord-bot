// Atlas Google Integration — Calendar + Gmail via OAuth2
// Uses native fetch (Node 18+). No googleapis npm dependency needed.

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

// --- Token cache ---
let cachedToken  = null;
let tokenExpires = 0;   // unix ms

export function isGoogleConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpires - 30_000) {
    return cachedToken;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type:    'refresh_token',
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.access_token) {
      return { error: 'Google auth expired', details: data.error_description || data.error || 'Unknown error' };
    }

    cachedToken  = data.access_token;
    // expires_in is in seconds; fall back to 55 minutes if absent
    tokenExpires = Date.now() + (data.expires_in ?? 3300) * 1000;
    return cachedToken;
  } catch (err) {
    return { error: 'Google auth expired', details: err.message };
  }
}

// Helper: get a token and return early with an error object if it failed
async function authedFetch(url, options = {}) {
  const token = await getAccessToken();
  if (token?.error) return { tokenError: token };

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  const data = await res.json();
  if (!res.ok) {
    return { fetchError: { status: res.status, message: data?.error?.message ?? JSON.stringify(data) } };
  }
  return { ok: true, data };
}

// --- Google Calendar ---

export async function getCalendarEvents(daysAhead = 1) {
  try {
    const now    = new Date();
    const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      timeMin:      now.toISOString(),
      timeMax:      future.toISOString(),
      singleEvents: 'true',
      orderBy:      'startTime',
    });

    const result = await authedFetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`
    );

    if (result.tokenError) return result.tokenError;
    if (result.fetchError) return { error: 'Calendar fetch failed', details: result.fetchError.message };

    const items = result.data.items ?? [];
    return items.map(event => ({
      title:       event.summary    ?? '(No title)',
      start:       event.start?.dateTime ?? event.start?.date ?? null,
      end:         event.end?.dateTime   ?? event.end?.date   ?? null,
      location:    event.location    ?? null,
      description: event.description ?? null,
    }));
  } catch (err) {
    return { error: 'Calendar fetch failed', details: err.message };
  }
}

// --- Gmail ---

export async function getEmails({ maxResults = 10, query = 'is:unread' } = {}) {
  try {
    // Step 1: fetch message IDs
    const listParams = new URLSearchParams({ maxResults: String(maxResults), q: query });
    const listResult = await authedFetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?${listParams}`
    );

    if (listResult.tokenError) return listResult.tokenError;
    if (listResult.fetchError) return { error: 'Gmail fetch failed', details: listResult.fetchError.message };

    const messages = listResult.data.messages ?? [];
    if (messages.length === 0) return [];

    // Step 2: fetch each message's metadata in parallel
    const detailResults = await Promise.all(
      messages.map(msg => {
        const url =
          `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}` +
          `?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
        return authedFetch(url);
      })
    );

    return detailResults
      .filter(r => r.ok)
      .map(r => {
        const msg     = r.data;
        const headers = msg.payload?.headers ?? [];
        const header  = name => headers.find(h => h.name === name)?.value ?? null;

        return {
          id:      msg.id,
          from:    header('From'),
          to:      header('To'),
          subject: header('Subject'),
          date:    header('Date'),
          snippet: msg.snippet ?? null,
          labels:  msg.labelIds ?? [],
        };
      });
  } catch (err) {
    return { error: 'Gmail fetch failed', details: err.message };
  }
}

export async function getEmailStats() {
  try {
    // Unread count
    const unreadResult = await authedFetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread', maxResults: '1' })}`
    );
    if (unreadResult.tokenError) return unreadResult.tokenError;
    if (unreadResult.fetchError) return { error: 'Gmail stats failed', details: unreadResult.fetchError.message };

    const unread_count = unreadResult.data.resultSizeEstimate ?? 0;

    // Urgent: important + unread
    const urgentResult = await authedFetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread label:important', maxResults: '1' })}`
    );
    const urgent_count = (urgentResult.ok ? urgentResult.data.resultSizeEstimate : 0) ?? 0;

    // Oldest unanswered
    let oldest_unanswered_hours = null;
    const oldestResult = await authedFetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread in:inbox', maxResults: '1', orderBy: 'oldest' })}`
    );
    if (oldestResult.ok) {
      const oldMsgs = oldestResult.data.messages ?? [];
      if (oldMsgs.length > 0) {
        const detailUrl =
          `https://www.googleapis.com/gmail/v1/users/me/messages/${oldMsgs[0].id}` +
          `?format=metadata&metadataHeaders=Date`;
        const detailResult = await authedFetch(detailUrl);
        if (detailResult.ok) {
          const headers = detailResult.data.payload?.headers ?? [];
          const dateStr = headers.find(h => h.name === 'Date')?.value;
          if (dateStr) {
            const msgDate = new Date(dateStr);
            if (!isNaN(msgDate)) {
              oldest_unanswered_hours = Math.floor((Date.now() - msgDate.getTime()) / 3_600_000);
            }
          }
        }
      }
    }

    return { unread_count, urgent_count, oldest_unanswered_hours };
  } catch (err) {
    return { error: 'Gmail stats failed', details: err.message };
  }
}

// --- OAuth flow helpers ---

export function getAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCodeForTokens(code, redirectUri) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  redirectUri,
        code,
        grant_type: 'authorization_code',
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { error: 'Token exchange failed', details: data.error_description ?? data.error ?? 'Unknown error' };
    }

    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_in:    data.expires_in,
      token_type:    data.token_type,
    };
  } catch (err) {
    return { error: 'Token exchange failed', details: err.message };
  }
}
