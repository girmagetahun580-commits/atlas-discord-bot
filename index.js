import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, entersState,
} from '@discordjs/voice';
import { Readable } from 'stream';
import { SYSTEM_PROMPT, VOICE_GREETING } from './system-prompt.js';
import { getHistory, addMessage } from './memory.js';
import { startHealthServer, markOnline, markActivity } from './health.js';

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'Daniel';
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const VOICE_CHANNEL = process.env.VOICE_CHANNEL_NAME || 'Atlas Voice';
const TEXT_CHANNEL = process.env.TEXT_CHANNEL_NAME || 'atlas';
const STATUS_CHANNEL = process.env.STATUS_CHANNEL_NAME || 'bot-status';

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
  ],
});

async function chatWithLLM(history, userMessage, systemOverride = null) {
  const messages = [
    { role: 'system', content: systemOverride || SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: 1024,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log(`Groq attempt ${attempt}/${maxRetries}: ${response.status} - ${errText.slice(0, 200)}`);
        if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
          continue;
        }
        throw new Error(`Groq API error: ${response.status}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.log(`Groq attempt ${attempt}/${maxRetries}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error('All retries exhausted');
}

discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== TEXT_CHANNEL) return;
  markActivity();
  const history = getHistory(message.channel.id);
  try {
    await message.channel.sendTyping();
    const reply = await chatWithLLM(history, message.content);
    addMessage(message.channel.id, 'user', message.content);
    addMessage(message.channel.id, 'assistant', reply);
    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g);
      for (const chunk of chunks) await message.reply(chunk);
    } else {
      await message.reply(reply);
    }
  } catch (err) {
    console.error('Text chat error:', err.message || err);
    await message.reply('Sorry, I hit an error. Try again in a moment.');
    logError(err);
  }
});

async function logError(err) {
  try {
    const guild = discord.guilds.cache.first();
    if (!guild) return;
    const channel = guild.channels.cache.find(c => c.name === STATUS_CHANNEL);
    if (!channel) return;
    await channel.send(`\u26a0\ufe0f **Atlas Error** (${new Date().toISOString()})\n\`\`\`${String(err.message || err).slice(0, 1500)}\`\`\``);
  } catch { }
}

async function textToSpeech(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        output_format: 'mp3_44100_128',
      }),
    }
  );
  if (!response.ok) throw new Error(`ElevenLabs TTS error: ${response.status}`);
  return Readable.fromWeb(response.body);
}

async function speechToText(audioBuffer) {
  const response = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_KEY}`,
        'Content-Type': 'audio/raw;encoding=signed-integer;bits=16;rate=48000;channels=1',
      },
      body: audioBuffer,
    }
  );
  if (!response.ok) throw new Error(`Deepgram STT error: ${response.status}`);
  const result = await response.json();
  return result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

async function playAudio(player, text) {
  const stream = await textToSpeech(text);
  const resource = createAudioResource(stream, { inputType: 2 });
  player.play(resource);
  return new Promise((resolve) => { player.once(AudioPlayerStatus.Idle, resolve); });
}

function listenToUser(connection, userId) {
  return new Promise((resolve) => {
    const chunks = [];
    const subscription = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });
    subscription.on('data', (chunk) => chunks.push(chunk));
    subscription.on('end', () => resolve(Buffer.concat(chunks)));
    setTimeout(() => { subscription.destroy(); resolve(Buffer.concat(chunks)); }, 30000);
  });
}

async function voiceConversationLoop(connection, userId, guildId) {
  const player = createAudioPlayer();
  connection.subscribe(player);
  const history = getHistory(`voice-${guildId}`);
  await playAudio(player, VOICE_GREETING);
  console.log('Voice loop started.');
  while (connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      const audioBuffer = await listenToUser(connection, userId);
      if (audioBuffer.length < 4800) continue;
      const transcript = await speechToText(audioBuffer);
      if (!transcript || transcript.trim().length === 0) continue;
      console.log(`User said: "${transcript}"`);
      markActivity();
      if (['bye atlas', 'goodbye atlas', 'leave', 'disconnect'].includes(transcript.toLowerCase().trim())) {
        await playAudio(player, 'Talk to you later. Bye!');
        connection.destroy();
        return;
      }
      const voicePrompt = SYSTEM_PROMPT + '\n\nVOICE MODE. Keep responses under 3 sentences. No markdown.';
      const reply = await chatWithLLM(history, transcript, voicePrompt);
      addMessage(`voice-${guildId}`, 'user', transcript);
      addMessage(`voice-${guildId}`, 'assistant', reply);
      console.log(`Atlas says: "${reply}"`);
      await playAudio(player, reply);
    } catch (err) {
      console.error('Voice loop error:', err.message || err);
      logError(err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

discord.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.channel?.name === VOICE_CHANNEL && !newState.member.user.bot && oldState.channel?.name !== VOICE_CHANNEL) {
    console.log(`${newState.member.displayName} joined ${VOICE_CHANNEL}. Connecting...`);
    try {
      const connection = joinVoiceChannel({
        channelId: newState.channel.id, guildId: newState.guild.id,
        adapterCreator: newState.guild.voiceAdapterCreator, selfDeaf: false,
      });
      connection.on('stateChange', (oldS, newS) => console.log(`Voice: ${oldS.status} > ${newS.status}`));
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch { connection.destroy(); }
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log('Connected to voice channel.');
      voiceConversationLoop(connection, newState.member.id, newState.guild.id);
    } catch (err) {
      console.error('Failed to join voice:', err.message);
      logError(err);
    }
  }
});

discord.once(Events.ClientReady, async (client) => {
  console.log(`\u2705 Atlas is online as ${client.user.tag}`);
  console.log(`   LLM: Groq (${GROQ_MODEL})`);
  console.log(`   Listening for text in #${TEXT_CHANNEL}`);
  console.log(`   Listening for voice in \ud83d\udd0a ${VOICE_CHANNEL}`);
  markOnline();
  try {
    const guild = client.guilds.cache.first();
    if (guild) {
      const statusCh = guild.channels.cache.find(c => c.name === STATUS_CHANNEL);
      if (statusCh) await statusCh.send(`\u2705 **Atlas is online** (${new Date().toISOString()})\nLLM: Groq ${GROQ_MODEL}`);
    }
  } catch { }
});

startHealthServer();
discord.login(DISCORD_TOKEN);
