// SRE AI Agent Backend
// Node.js + Express webhook for Grafana/Alertmanager
// Receives alert payloads, enriches them with Prometheus metrics if configured,
// and returns a concise anomaly analysis.

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 5000;

const AI_PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase(); // mock | openai | openrouter
// const AI_MODEL = process.env.AI_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
// const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b:free';
const AI_MODEL = process.env.AI_MODEL || 'arcee-ai/trinity-large-preview:free';

const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://api.openai.com/v1';

// Optional Prometheus query support (for enrichment)
// Example for Grafana Cloud Prometheus:
// PROMETHEUS_API_URL=https://prometheus-prod-xx-prod-<region>.grafana.net/api/prom
// PROMETHEUS_BASIC_AUTH=base64(username:password)  -> only if you want to set Authorization header manually
const PROMETHEUS_API_URL = process.env.PROMETHEUS_API_URL || '';
const PROMETHEUS_BEARER_TOKEN = process.env.PROMETHEUS_BEARER_TOKEN || '';
const PROMETHEUS_BASIC_AUTH = process.env.PROMETHEUS_BASIC_AUTH || '';

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



function authHeaders() {
  const headers = {};
  if (PROMETHEUS_BEARER_TOKEN) headers.Authorization = `Bearer ${PROMETHEUS_BEARER_TOKEN}`;
  if (PROMETHEUS_BASIC_AUTH) headers.Authorization = `Basic ${PROMETHEUS_BASIC_AUTH}`;
  return headers;
}

function pickAlert(alertPayload) {
  const alerts = alertPayload?.alerts || [];
  const firing = alerts.find((a) => a.status === 'firing') || alerts[0] || null;
  return firing;
}

function safeNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function queryPrometheus(query) {
  if (!PROMETHEUS_API_URL) return null;

  const url = `${PROMETHEUS_API_URL.replace(/\/$/, '')}/api/v1/query`;
  const resp = await axios.get(url, {
    params: { query },
    headers: authHeaders(),
    timeout: 10000,
  });

  const data = resp.data;
  if (data?.status !== 'success') return null;
  const result = data?.data?.result || [];
  if (!result.length) return null;

  const series = result[0];
  const rawValue = series?.value?.[1];
  return {
    metric: series?.metric || {},
    value: safeNum(rawValue),
    raw: data,
  };
}




function buildAnalysisContext(alertPayload, metrics) {
  const alert = pickAlert(alertPayload);

  return {
    receiver: alertPayload?.receiver || null,
    status: alertPayload?.status || null,
    alertname: alert?.labels?.alertname || alert?.labels?.alert || 'unknown-alert',
    severity: alert?.labels?.severity || 'unknown',
    service: alert?.labels?.service || alert?.labels?.job || 'unknown-service',
    instance: alert?.labels?.instance || null,
    summary: alert?.annotations?.summary || null,
    description: alert?.annotations?.description || null,
    startsAt: alert?.startsAt || null,
    endsAt: alert?.endsAt || null,
    generatorURL: alert?.generatorURL || null,
    labels: alert?.labels || {},
    annotations: alert?.annotations || {},
    metrics: metrics || {},
  };
}

function fallbackAnalysis(ctx) {
  const currentRps = ctx.metrics?.currentRps?.value;
  const baselineRps = ctx.metrics?.baselineRps?.value;
  const errorRate = ctx.metrics?.errorRate?.value;
  const latencyP95 = ctx.metrics?.latencyP95?.value;
  

  let increaseText = '';
  if (currentRps != null && baselineRps != null && baselineRps > 0) {
    const pct = Math.round(((currentRps - baselineRps) / baselineRps) * 100);
    increaseText = `Traffic changed by about ${pct}% compared with baseline.`;
  } else {
    increaseText = 'Traffic anomaly detected, but baseline comparison is unavailable.';
  }

  const hints = [];
  if (errorRate != null && errorRate > 0.01) hints.push(`Error rate is elevated (${errorRate}).`);
  if (latencyP95 != null && latencyP95 > 500) hints.push(`Latency p95 is high (${latencyP95} ms).`);
  if (!hints.length) hints.push('No obvious error or latency spike was included in the current payload.');

  return [
    `Alert: ${ctx.alertname}`,
    increaseText,
    ...hints,
    'Likely causes: load-test spike, retry storm, bot surge, or upstream dependency pressure.',
    'This is an anomaly signal, not a confirmed root cause.',
  ].join(' ');
}


async function askAI(ctx) {
  const prompt = `
You are a Site Reliability AI Agent.

Analyze this alert and respond in 4 short sections:
1) What happened
2) Severity
3) Possible causes (not definitive root cause)
4) Next checks

Rules:
- Be cautious. Do NOT claim exact root cause unless evidence is present.
- Mention uncertainty when metrics are incomplete.
- Keep the answer concise and practical.

Alert context:
${JSON.stringify(ctx, null, 2)}
`.trim();

  if (AI_PROVIDER === 'mock' || !AI_API_KEY) {
    return fallbackAnalysis(ctx);
  }

  // OpenAI-compatible API call (works for OpenAI and many OpenAI-compatible providers)
  const url = `${AI_API_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AI_API_KEY}`,
  };

  const body = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: 'You are a careful SRE incident analyst.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };

  const resp = await axios.post(url, body, { headers, timeout: 20000 });
  const content = resp.data?.choices?.[0]?.message?.content;
  return content || fallbackAnalysis(ctx);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sre-ai-agent', ai_provider: AI_PROVIDER });
});

// Main webhook endpoint for Grafana / Alertmanager
app.post('/api/analyze', async (req, res) => {
  try {
    const alertPayload = req.body || {};
    const alert = pickAlert(alertPayload);

    const context = buildAnalysisContext(alertPayload, {
      // Optional enrichment from Prometheus if configured.
      // Update these queries to match your own metric names if needed.
    });

    // Try to enrich with real Prometheus values (best-effort)
    try {
      const [currentRps, baselineRps, errorRate, latencyP95] = await Promise.all([
        queryPrometheus('sum(rate(k6_http_reqs_total[1m]))'),
        queryPrometheus('avg_over_time(sum(rate(k6_http_reqs_total[1m]))[10m:])'),
        queryPrometheus('sum(rate(k6_http_req_failed[1m]))'),
        queryPrometheus('quantile_over_time(0.95, k6_http_req_duration[5m])'),
      ]);

      context.metrics = {
        currentRps,
        baselineRps,
        errorRate,
        latencyP95,
      };
    } catch (enrichErr) {
      context.metrics = context.metrics || {};
      context.enrichmentError = enrichErr.message;
    }

    const analysis = await askAI(context);

    const response = {
      received: true,
      alertname: context.alertname,
      severity: context.severity,
      service: context.service,
      startsAt: context.startsAt,
      analysis,
      context: {
        summary: context.summary,
        description: context.description,
        labels: context.labels,
        annotations: context.annotations,
      },
    };

    console.log('Alert received:', JSON.stringify(response, null, 2));
    res.status(200).json(response);
  } catch (error) {
    console.error('Analyze endpoint error:', error.response?.data || error.message);
    res.status(500).json({
      received: false,
      error: 'Analysis failed',
      details: error.message,
    });
  }
});

// Optional test endpoint to manually simulate an alert
app.post('/api/test-alert', async (_req, res) => {
  try {
    const fakeAlert = {
      status: 'firing',
      receiver: 'ai-agent',
      alerts: [
        {
          status: 'firing',
          labels: {
            alertname: 'HighTrafficSpike',
            severity: 'warning',
            service: 'k6-test',
          },
          annotations: {
            summary: 'Traffic spike detected',
            description: 'Traffic is more than 2x the baseline',
          },
          startsAt: new Date().toISOString(),
          generatorURL: 'http://localhost:3000',
        },
      ],
    };

    const context = buildAnalysisContext(fakeAlert, {});
    const analysis = await askAI(context);

    res.json({ ok: true, analysis, context });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`SRE AI Agent running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Webhook:      http://localhost:${PORT}/api/analyze`);
});
