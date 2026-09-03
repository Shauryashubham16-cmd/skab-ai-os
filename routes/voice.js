const express = require('express');
const axios = require('axios');

const { validate } = require('../middleware/validate');
const { speakRequest } = require('../schemas');

const router = express.Router();

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// POST /api/voice/speak  { text, voiceId? }  -> streams back audio/mpeg
router.post('/speak', validate({ body: speakRequest }), async (req, res) => {
  const { text, voiceId } = req.body;

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set on the server' });
  }

  const voice = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voice) {
    return res.status(400).json({ error: 'No voiceId provided and ELEVENLABS_VOICE_ID is not set in .env' });
  }

  try {
    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${voice}`,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );

    res.set('Content-Type', 'audio/mpeg');
    res.send(response.data);
  } catch (err) {
    const detail = err.response?.data ? Buffer.from(err.response.data).toString('utf8') : err.message;
    console.error('[voice/speak] error:', detail);
    res.status(502).json({ error: 'Failed to generate speech', detail });
  }
});

// GET /api/voice/voices — list available voices in your ElevenLabs account
router.get('/voices', async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set on the server' });
  }

  try {
    const { data } = await axios.get(`${ELEVENLABS_BASE}/voices`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    res.json(data.voices.map((v) => ({ voiceId: v.voice_id, name: v.name })));
  } catch (err) {
    console.error('[voice/voices] error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Failed to list voices', detail: err.message });
  }
});

module.exports = router;
