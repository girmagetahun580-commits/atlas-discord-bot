# Atlas Discord Bot

Personal AI assistant with voice + text support.

**Voice:** Join the "Atlas Voice" channel → Atlas joins automatically, greets you, and has a live conversation using ElevenLabs voice.

**Text:** Message in #atlas channel → Atlas responds with Gemini.

## Quick Start

1. Copy `.env.example` to `.env` and fill in your API keys
2. `npm install`
3. `npm start`

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add your environment variables from `.env.example`
4. Railway auto-deploys on push

## Required API Keys

| Service | Get it at | Free tier |
|---------|-----------|----------|
| Discord Bot Token | discord.com/developers | Free |
| Google Gemini | aistudio.google.com | Free tier available |
| ElevenLabs | elevenlabs.io | 10K chars/mo free |
| Deepgram | deepgram.com | $200 free credit |

## Commands

- Join 🔊 Atlas Voice → Atlas auto-joins and starts listening
- Say "bye Atlas" or "disconnect" → Atlas leaves the voice channel
- Type in #atlas → Atlas responds in text
