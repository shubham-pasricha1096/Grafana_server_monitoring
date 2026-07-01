require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = 5000;

// ===== CONFIG =====
const AI_PROVIDER = process.env.AI_PROVIDER || 'mock'; // fallback to mock if no key
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://openrouter.ai/api/v1';
const AI_MODEL = process.env.AI_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;
const GRAFANA_DS_UID = process.env.GRAFANA_DS_UID;

// ===== GRAFANA DATASOURCE QUERY (Prometheus) =====
async function queryProm(promQuery) {
  try {
    const res = await axios.post(
      `${GRAFANA_URL}/api/ds/query`,
      {
        queries: [
          {
            refId: 'A',
            datasource: { 
              type: "prometheus",
              uid: GRAFANA_DS_UID },
            expr: promQuery,
            instant: false,
          },
        ],
        from: 'now-5m',
        to: 'now',
      },
      {
        headers: {
          Authorization: `Bearer ${GRAFANA_API_KEY}`,
          'Content-Type': 'application/json',
          "HTTP-Referer": "http://localhost:5000",
          "X-Title": "Grafana MCP",
        },
      }
    );

    console.log(
      JSON.stringify(res.data, null, 2)
    );

    const frames = res.data?.results?.A?.frames;

    if (!frames || frames.length === 0) return null;

    const values = frames[0]?.data?.values;

    if (!values || values.length < 2 || values[1].length === 0) return null;

    return {
      latest: parseFloat(values[1][values[1].length - 1]),
      series: values[1]
    };
  } catch (e) {
    console.error('Prometheus Query Error:', e.response?.data || e.message);
    return null;
  }
}


// ===== GRAFANA DASHBOARD QUERY =====
async function queryGrafana(path) {
  try {
    const res = await axios.get(`${GRAFANA_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${GRAFANA_API_KEY}`,
      },
    });
    return res.data;
  } catch (e) {
    console.error('Grafana API Error:', e.response?.data || e.message);
    return { error: e.message };
  }
}

// ===== ALERT ENGINE =====
function detectAlerts({ traffic, errorRate, latency, spike, prev, curr }) {
  const alerts = [];

  if (traffic > 200) {
    alerts.push({
      type: "traffic",
      severity: "High",
      message: `High traffic: ${traffic} req/sec`
    });
  }

  if (errorRate > 0.05) {
    alerts.push({
      type: "error",
      severity: "Critical",
      message: `Error rate: ${(errorRate * 100).toFixed(2)}%`
    });
  }

  if (latency > 2000) {
    alerts.push({
      type: "latency",
      severity: "High",
      message: `Latency: ${latency} ms`
    });
  }

  if (spike) {
  alerts.push({
    type: "spike",
    severity: "Critical",
    message: `Traffic spike detected: ${prev} → ${curr}`
  });
}

  return alerts;
}

  function fallbackAnalysis({ traffic = 0, errorRate = 0, latency = 0 }) {
        return `f



        
      Fallback Analysis:
      Traffic: ${traffic}
      Error Rate: ${errorRate}
      Latency: ${latency}

      System under load (k6 test scenario).
      `;
      }

// ===== AI CALL =====
async function askAI(prompt) {
  if (AI_PROVIDER === 'mock' || !AI_API_KEY) {
    return fallbackAnalysis({});
  }

  try {
    const res = await axios.post(
      `${AI_API_BASE_URL}/chat/completions`,
      {
        model: AI_MODEL,
        messages: [
          { role: "system", content: "You are an SRE expert." },
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:5000",
          "X-Title": "Grafana MCP"
        }
      }
    );

        return res.data.choices?.[0]?.message?.content || "No AI response";
    } catch (e) {
      console.error("AI Error:", e.response?.data || e.message);
      return "AI failed";
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

app.get('/test', async (req, res) => {
  const val = await queryProm(
  'sum(rate(k6_http_reqs_total[1m]))'
);
  res.json({ val });
});

app.get('/mcp/grafana/query', async (req, res) => {
  const query = req.query.q;
  const data = await axios.post(
    `${GRAFANA_URL}/api/ds/query`,
    {
      queries: [
        {
          refId: 'A',
          datasource: { uid: GRAFANA_DS_UID },
          expr: query,
          range: true,
        },
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

// ===== GRAFANA WEBHOOK (NEW) =====
app.post('/webhook/grafana', async (req, res) => {
  try {
    const body = req.body;

    console.log("📩 Webhook received:", JSON.stringify(body, null, 2));

    const alerts = body.alerts || [];

    const formatted = alerts.map(a => ({
      name: a.labels?.alertname || "unknown",
      severity: a.labels?.severity || "unknown",
      value: a.annotations?.value || "N/A",
      description: a.annotations?.description || "No description"
    }));

    // 🔥 AI prompt (simpler than /api/analyze)
    const prompt = `
You are an SRE expert.

Incoming Grafana Alerts:
${formatted.map(a => `
Alert: ${a.name}
Severity: ${a.severity}
Value: ${a.value}
Description: ${a.description}
`).join("\n")}

Explain:
- root cause
- impact
- recommended action
`;

    const aiResponse = await askAI(prompt);

    console.log("🤖 AI Analysis:\n", aiResponse);

    res.json({
      ok: true,
      alerts: formatted,
      analysis: aiResponse
    });

  } catch (err) {
    console.error("Webhook Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== MAIN WEBHOOK =====
app.post('/api/analyze', async (req, res) => {
  try {
    // ===== 🔥 STEP 1: Extract queries from Grafana =====
    const dashboard = await queryGrafana(`/api/dashboards/uid/shf6pbx`);

    const panels = dashboard.dashboard?.panels || [];
    const queries = [];

    panels.forEach(p => {
      p.targets?.forEach(t => {
        if (t.expr) queries.push(t.expr);
      });
    });
  
    // ===== 🔥 STEP 2: Fetch values =====
    const results = [];

    for (const q of queries) {
      const res = await queryProm(q);
      results.push(res);
    }

    const values = results.map(r => r?.latest ?? 0);
    const seriesList = results.map(r => r?.series ?? []);
  
    let traffic = 0, errorRate = 0, latency = 0;

  queries.forEach((q, i) => {
    if (q.includes("http_reqs")) traffic = values[i];
    if (q.includes("http_req_failed")) errorRate = values[i];
    if (q.includes("duration")) latency = values[i];
  });

  const trafficSeries = seriesList[0] || [];

  const prev = trafficSeries[trafficSeries.length - 2] || 0;
  const curr = trafficSeries[trafficSeries.length - 1] || 0;

  const spike = curr > prev * 2;

  const alerts = detectAlerts({ traffic, errorRate, latency, spike, prev, curr });

    alerts.forEach(a => console.log(`🚨 ${a.message}`));

  const enriched = queries.map((q, i) =>
    `Query: ${q}\nValue: ${values[i]}\n`
  );

  const trendData = `

  Traffic: ${prev} → ${curr}
  Spike: ${spike ? "YES" : "NO"}
  `;

    // ===== 🔥 STEP 4: Create AI prompt =====
    const prompt = `
      You are an SRE monitoring expert.

      Metrics:
      ${enriched.join("\n")}

      Latest vs Previous:
      ${trendData}

      Detected Alerts:
      ${alerts.map(a => `${a.type} - ${a.severity}: ${a.message}`).join("\n")}

      Explain:
      - Root cause
      - Impact
      - Recommended action

      Rules:
      - Spike if value increases >2x
      - High traffic if >200 req/sec

      Detect:
      - anomalies
      - spikes
      - issues

      Give severity + action.

      `;
    // ===== 🔥 STEP 5: Call AI =====
    const analysis = await askAI(prompt);

    console.log('AI OUTPUT:\n', analysis);

    res.json({
    ok: true,
    alerts,
    analysis,
    metrics: { traffic, errorRate, latency }
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
    }
  );
