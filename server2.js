require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = 5000;

// ===== CONFIG =====
const AI_PROVIDER = process.env.AI_PROVIDER || 'mock'; // use mock to avoid rate limit
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

const PROM_URL = process.env.PROMETHEUS_API_URL;
const PROM_AUTH = process.env.PROMETHEUS_BASIC_AUTH;

// ===== PROMETHEUS QUERY =====
async function queryProm(query) {
  try {
    const res = await axios.get(`${PROM_URL}/api/v1/query`, {
      params: { query },
      headers: {
        Authorization: `Basic ${PROM_AUTH}`,
      },
    });

    const result = res.data?.data?.result;
    if (!result || result.length === 0) return null;

    return parseFloat(result[0].value[1]);
  } catch (e) {
    return null;
  }
}

// ===== MCP ENDPOINTS =====
app.get('/mcp/traffic', async (req, res) => {
  const value = await queryProm('sum(rate(k6_http_reqs_total[1m]))');
  res.json({ traffic: value });
});

app.get('/mcp/errors', async (req, res) => {
  const value = await queryProm('sum(rate(k6_http_req_failed[1m]))');
  res.json({ errorRate: value });
});

app.get('/mcp/latency', async (req, res) => {
  const value = await queryProm(
    'histogram_quantile(0.95, sum(rate(k6_http_req_duration_bucket[1m])) by (le))'
  );
  res.json({ latency: value });
});

// ===== AI ANALYSIS =====
function fallbackAnalysis(ctx) {
  const { traffic, errorRate, latency, signal } = ctx;

  let message = `Alert: ${signal}\n`;

  if (signal === 'traffic') {
    message += `Traffic spike detected: ${traffic} req/sec\n`;
  }

  if (signal === 'error') {
    message += `High error rate: ${errorRate}\n`;
  }

  if (signal === 'latency') {
    message += `High latency: ${latency} ms\n`;
  }

  if (errorRate < 0.01) {
    message += `System stable (low error rate)\n`;
  }

  message += `Likely cause: load spike or stress test`;

  return message;
}

async function askAI(ctx) {
  if (AI_PROVIDER === 'mock' || !AI_API_KEY) {
    return fallbackAnalysis(ctx);
  }

  try {
    const response = await axios.post(
      `${AI_API_BASE_URL}/chat/completions`,
      {
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'You are an SRE expert.' },
          { role: 'user', content: JSON.stringify(ctx) },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (e) {
    return fallbackAnalysis(ctx);
  }
}

// ===== MAIN WEBHOOK =====
app.post('/api/analyze', async (req, res) => {
  try {
    const alert = req.body?.alerts?.[0];

    const signal = alert?.labels?.signal || 'unknown';

    // Fetch real metrics
    const [traffic, errorRate, latency] = await Promise.all([
      queryProm('sum(rate(k6_http_reqs_total[1m]))'),
      queryProm('sum(rate(k6_http_req_failed[1m]))'),
      queryProm(
        'histogram_quantile(0.95, sum(rate(k6_http_req_duration_bucket[1m])) by (le))'
      ),
    ]);

    const ctx = {
      signal,
      traffic,
      errorRate,
      latency,
    };

    const analysis = await askAI(ctx);

    console.log('AI OUTPUT:\n', analysis);

    res.json({
      ok: true,
      signal,
      analysis,
      metrics: ctx,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});