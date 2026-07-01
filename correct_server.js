require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = 5000;

// ===== CONFIG =====
const AI_PROVIDER = process.env.AI_PROVIDER || 'openrouter'; // use mock to avoid rate limit
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.openai.com/api/v1';
const AI_MODEL = process.env.AI_MODEL || 'arcee-ai/trinity-large-preview:free';

const PROM_URL = process.env.PROMETHEUS_API_URL;
const PROM_AUTH = process.env.PROMETHEUS_BASIC_AUTH;

const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;

// ===== PROMETHEUS QUERY =====
async function queryGrafana(path) {
  try {
    const res = await axios.get(`${GRAFANA_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${GRAFANA_API_KEY}`,
      },
    });
    return res.data;
  } catch (e) {
    return { error: e.message };
  }
}

async function queryProm(promQuery) {
  try {
    const res = await axios.post(
      `${GRAFANA_URL}/api/ds/query`,
      {
        queries: [
          {
            datasource: {
              uid: "shf6pbx" // 🔥 IMPORTANT
            },
            expr: promQuery,
            refId: "A",
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${GRAFANA_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

const frames = res.data?.results?.A?.frames;

if (!frames || frames.length === 0) return null;

const values = frames[0].data.values;

// last value
if (!values || values.length < 2 || values[1].length === 0) {
  return null;
}

const latest = values[1][values[1].length - 1];

return latest;
  } catch (e) {
    return { error: e.message };
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

app.get('/mcp/grafana/dashboards', async (req, res) => {
  const data = await queryGrafana('/api/search');
  res.json(data);
});

app.get('/mcp/grafana/dashboard/:uid', async (req, res) => {
  const uid = req.params.uid;
  const data = await queryGrafana(`/api/dashboards/uid/${uid}`);
  res.json(data);
});

app.get('/mcp/grafana/query', async (req, res) => {
  const query = req.query.q;

  const data = await axios.post(
    `${GRAFANA_URL}/api/ds/query`,
    {
      queries: [
        {
          refId: "A",
          datasource: {
            uid: "shf6pbx"
          },
          expr: query,
          range: true
        }
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${GRAFANA_API_KEY}`,
      },
    }
  );

  res.json(data.data);
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

  if (errorRate !== null && errorRate < 0.01) {
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

