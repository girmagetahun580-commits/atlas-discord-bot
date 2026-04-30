import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Readable } from 'stream';
import { SYSTEM_PROMPT, VOICE_GREETING, THINKING_PHRASES } from './system-prompt.js';

// ─── Config ───
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'Daniel';
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const VOICE_CHANNEL = process.env.VOICE_CHANNEL_NAME || 'Atlas Voice';
const TEXT_CHANNEL = process.env.TEXT_CHANNEL_NAME || 'atlas';

// ─── Clients ───
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// Conversation history (per-channel, in-memory — resets on restart)
const conversations = new Map();

function getHistory(channelId) {
  if (!conversations.has(channelId)) {
    conversations.set(channelId, []);
  }
  return conversations.get(channelId);
}

// ─── GEMINI CHAT HELPER ───
async function chatWithGemini(history, userMessage, systemOverride = null) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemOverride || SYSTEM_PROMPT,
  });

  // Convert our history format to Gemini format
  const geminiHistory = history.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  const chat = model.startChat({
    history: geminiHistory,
  });

  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

// ─── TEXT CHAT HANDLER ───
discord.on(Events.MessageCreate, async (message) => {
  // Ignore bots and messages outside the atlas text channel
  if (message.author.bot) return;
  if (message.channel.name !== TEXT_CHANNEL) return;

  const history = getHistory(message.channel.id);

  try {
    await message.channel.sendTyping();

    const reply = await chatWithGemini(history, message.content);

    // Update history
    history.push({ role: 'user', content: message.content });
    history.push({ role: 'assistant', content: reply });

    // Keep history reasonable (last 20 exchanges)
    if (history.length > 40) history.splice(0, history.length - 40);

    // Split long messages (Discord 2000 char limit)
    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(reply);
    }
  } catch (err) {
    console.error('Text chat error:', err);
    await message.reply("Sorry, I hit an error. Try again in a moment.");
  }
});

// ─── VOICE HANDLER ───

// ElevenLabs TTS: returns a readable stream of audio bytes (mp3)
async function textToSpeech(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: 1.0,
        },
        output_format: 'mp3_44100_128',
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS error: ${response.status}`);
  }

  return Readable.fromWeb(response.body);
}

// Deepgram STT: transcribe audio buffer
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

  if (!response.ok) {
    throw new Error(`Deepgram STT error: ${response.status}`);
  }

  const result = await response.json();
  return result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

// Play audio in voice channel
async function playAudio(player, text) {
  const stream = await textToSpeech(text);
  const resource = createAudioResource(stream, { inputType: 2 });
  player.play(resource);
  return new Promise((resolve) => {
    player.once(AudioPlayerStatus.Idle, resolve);
  });
}

// Listen to a user speaking and return the audio buffer
function listenToUser(connection, userId) {
  return new Promise((resolve) => {
    const receiver = connection.receiver;
    const chunks = [];

    const subscription = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });

    subscription.on('data', (chunk) => {
      chunks.push(chunk);
    });

    subscription.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    // Safety timeout — max 30 seconds of listening
    setTimeout(() => {
      subscription.destroy();
      resolve(Buffer.concat(chunks));
    }, 30000);
  });
}

// Main voice conversation loop
async function voiceConversationLoop(connection, userId, guildId) {
  const player = createAudioPlayer();
  connection.subscribe(player);

  const history = getHistory(`voice-${guildId}`);

  // Greet
  await playAudio(player, VOICE_GREETING);

  console.log('Voice loop started. Listening...');

  while (connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      // Listen for user speech
      const audioBuffer = await listenToUser(connection, userId);

      if (audioBuffer.length < 4800) {
        continue;
      }

      // Transcribe
      const transcript = await speechToText(audioBuffer);
      console.log(`User said: "${transcript}"`);

      if (!transcript || transcript.trim().length === 0) continue;

      // Check for exit commands
      if (['bye atlas', 'goodbye atlas', 'leave', 'disconnect'].includes(transcript.toLowerCase().trim())) {
        await playAudio(player, "Talk to you later. Bye!");
        connection.destroy();
        return;
      }

      // Get Gemini response (voice mode)
      const voiceSystemPrompt = SYSTEM_PROMPT + '\n\nYou are currently in VOICE MODE on a Discord voice channel. Keep responses under 3 sentences. No markdown.';
      const reply = await chatWithGemini(history, transcript, voiceSystemPrompt);

      // Update history
      history.push({ role: 'user', content: transcript });
      history.push({ role: 'assistant', content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);

      console.log(`Atlas says: "${reply}"`);

      // Speak the response
      await playAudio(player, reply);
    } catch (err) {
      console.error('Voice loop error:', err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Watch for users joining the Atlas Voice channel
discord.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (
    newState.channel?.name === VOICE_CHANNEL &&
    !newState.member.user.bot &&
    oldState.channel?.name !== VOICE_CHANNEL
  ) {
    console.log(`${newState.member.displayName} joined ${VOICE_CHANNEL}. Connecting...`);

    try {
      const connection = joinVoiceChannel({
        channelId: newState.channel.id,
        guildId: newState.guild.id,
        adapterCreator: newState.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      console.log('Connected to voice channel.');

      voiceConversationLoop(connection, newState.member.id, newState.guild.id);
    } catch (err) {
      console.error('Failed to join voice:', err);
    }
  }
});

// ─── STARTUP ───
discord.once(Events.ClientReady, (client) => {
  console.log(`✅ Atlas is online as ${client.user.tag}`);
  console.log(`   Model: ${GEMINI_MODEL}`);
  console.log(`   Listening for text in #${TEXT_CHANNEL}`);
  console.log(`   Listening for voice in 🔊 ${VOICE_CHANNEL}`);
});

discord.login(DISCORD_TOKEN);
