// ============================================================
//  SRE AI Agent — Single Complete Server
//  Stack: Express → Grafana (Prometheus datasource) → OpenRouter
//  Alerts handled: traffic_spike | latency | error_spike | saturation
// ============================================================

require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─────────────────────────────────────────────
//  CONFIG  (all values come from .env)
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

// AI
const AI_PROVIDER    = (process.env.AI_PROVIDER    || 'openrouter').toLowerCase();
const AI_API_KEY     =  process.env.AI_API_KEY     || '';
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://openrouter.ai/api/v1';
const AI_MODEL       =  process.env.AI_MODEL       || 'mistralai/mistral-7b-instruct:free';

// Grafana (acts as the Prometheus proxy)
const GRAFANA_URL     = (process.env.GRAFANA_URL    || '').replace(/\/$/, '');
const GRAFANA_API_KEY =  process.env.GRAFANA_API_KEY || '';
const GRAFANA_DS_UID  =  process.env.GRAFANA_DS_UID  || '';   // Prometheus datasource UID

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function grafanaHeaders() {
  return {
    Authorization: `Bearer ${GRAFANA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function safeNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickAlert(payload) {
  const alerts  = payload?.alerts || [];
  return alerts.find((a) => a.status === 'firing') || alerts[0] || null;
}

// ─────────────────────────────────────────────
//  PROMETHEUS VIA GRAFANA  (/api/ds/query)
// ─────────────────────────────────────────────

/**
 * Runs a single PromQL instant query through the Grafana proxy.
 * Returns the latest scalar value, or null on failure.
 */
async function queryProm(promQL) {
  if (!GRAFANA_URL || !GRAFANA_DS_UID) return null;

  try {
    const res = await axios.post(
      `${GRAFANA_URL}/api/ds/query`,
      {
        queries: [
          {
            datasource: { uid: GRAFANA_DS_UID },
            expr:   promQL,
            refId:  'A',
            instant: true,
          },
        ],
        from: 'now-5m',
        to:   'now',
      },
      { headers: grafanaHeaders(), timeout: 12000 }
    );

    const frames = res.data?.results?.A?.frames;
    if (!frames?.length) return null;

    const values = frames[0]?.data?.values;
    if (!values || values.length < 2 || !values[1].length) return null;

    // Return the last value in the series
    return safeNum(values[1][values[1].length - 1]);
  } catch (e) {
    console.error(`queryProm error [${promQL}]:`, e.message);
    return null;
  }
}

/**
 * Fetches a raw Grafana REST path (dashboards, etc.)
 */
async function grafanaGet(path) {
  try {
    const res = await axios.get(`${GRAFANA_URL}${path}`, {
      headers: grafanaHeaders(),
      timeout: 10000,
    });
    return res.data;
  } catch (e) {
    return { error: e.message };
  }
}

// ─────────────────────────────────────────────
//  METRIC COLLECTION  (all 4 alert types)
// ─────────────────────────────────────────────
async function collectMetrics() {
  const [
    currentRps,
    baselineRps,
    errorRate,
    latencyP95,
    cpuUsage,
    memUsage,
    diskUsage,
  ] = await Promise.all([
    // Traffic
    queryProm('sum(rate(k6_http_reqs_total[1m]))'),
    queryProm('avg_over_time(sum(rate(k6_http_reqs_total[1m]))[10m:1m])'),

    // Errors
    queryProm('sum(rate(k6_http_req_failed[1m]))'),

    // Latency
    queryProm(
      'histogram_quantile(0.95, sum(rate(k6_http_req_duration_bucket[1m])) by (le))'
    ),

    // Saturation — swap these PromQL expressions for your own exporters
    // (node_exporter examples shown; replace with process_cpu_seconds_total, etc.)
    queryProm('avg(rate(node_cpu_seconds_total{mode!="idle"}[2m])) * 100'),
    queryProm('(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100'),
    queryProm('(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_free_bytes{mountpoint="/"}) / node_filesystem_size_bytes{mountpoint="/"} * 100'),
  ]);

  return { currentRps, baselineRps, errorRate, latencyP95, cpuUsage, memUsage, diskUsage };
}

// ─────────────────────────────────────────────
//  ALERT CONTEXT BUILDER
// ─────────────────────────────────────────────
function buildContext(alertPayload, metrics) {
  const alert = pickAlert(alertPayload);

  return {
    receiver:    alertPayload?.receiver    || null,
    status:      alertPayload?.status      || null,
    alertname:   alert?.labels?.alertname  || alert?.labels?.alert || 'unknown-alert',
    severity:    alert?.labels?.severity   || 'unknown',
    service:     alert?.labels?.service    || alert?.labels?.job   || 'unknown-service',
    instance:    alert?.labels?.instance   || null,
    summary:     alert?.annotations?.summary     || null,
    description: alert?.annotations?.description || null,
    startsAt:    alert?.startsAt || null,
    endsAt:      alert?.endsAt   || null,
    labels:      alert?.labels   || {},
    annotations: alert?.annotations || {},
    metrics,
  };
}

// ─────────────────────────────────────────────
//  FALLBACK ANALYSIS  (when AI is unavailable)
// ─────────────────────────────────────────────
function fallbackAnalysis(ctx) {
  const { alertname, metrics } = ctx;
  const { currentRps, baselineRps, errorRate, latencyP95, cpuUsage, memUsage, diskUsage } = metrics;

  const lines = [`Alert: ${alertname}`];

  // Traffic
  if (currentRps != null) {
    if (baselineRps != null && baselineRps > 0) {
      const pct = Math.round(((currentRps - baselineRps) / baselineRps) * 100);
      lines.push(`Traffic: ${currentRps.toFixed(2)} req/s (${pct > 0 ? '+' : ''}${pct}% vs 10-min baseline).`);
    } else {
      lines.push(`Traffic: ${currentRps.toFixed(2)} req/s (no baseline available).`);
    }
  }

  // Errors
  if (errorRate != null) {
    lines.push(
      errorRate > 0.01
        ? `Error rate: ELEVATED at ${(errorRate * 100).toFixed(2)}%.`
        : `Error rate: low (${(errorRate * 100).toFixed(3)}%).`
    );
  }

  // Latency
  if (latencyP95 != null) {
    lines.push(
      latencyP95 > 500
        ? `Latency p95: HIGH at ${latencyP95.toFixed(0)} ms.`
        : `Latency p95: ${latencyP95.toFixed(0)} ms (within normal range).`
    );
  }

  // Saturation
  if (cpuUsage != null) lines.push(`CPU: ${cpuUsage.toFixed(1)}%`);
  if (memUsage  != null) lines.push(`Memory: ${memUsage.toFixed(1)}%`);
  if (diskUsage != null) lines.push(`Disk: ${diskUsage.toFixed(1)}%`);

  lines.push('Likely causes: load-test spike, retry storm, resource exhaustion, or upstream pressure.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  AI CALL  (OpenRouter / OpenAI-compatible)
// ─────────────────────────────────────────────
function buildPrompt(ctx) {
  return `
You are a Site Reliability AI Agent. Analyze the following alert and respond in exactly 4 labeled sections:

1) WHAT HAPPENED
   Summarize the incident based on alert metadata and metric values.

2) SEVERITY ASSESSMENT
   Rate overall severity (Critical / High / Medium / Low) and explain why.

3) POSSIBLE CAUSES
   List the most plausible causes for each signal present:
   - Traffic spike (if currentRps significantly exceeds baselineRps)
   - Error spike (if errorRate > 1%)
   - Latency spike (if latencyP95 > 500 ms)
   - Saturation (if cpuUsage, memUsage, or diskUsage > 80%)
   Do NOT claim a definitive root cause. Flag when data is missing.

4) RECOMMENDED NEXT CHECKS
   Provide specific, actionable steps the on-call engineer should take immediately.

Rules:
- Be concise and practical.
- Call out missing/null metrics explicitly.
- Do not hallucinate metric values.

Alert context (JSON):
${JSON.stringify(ctx, null, 2)}
`.trim();
}

async function askAI(ctx) {
  if (AI_PROVIDER === 'mock' || !AI_API_KEY) {
    return fallbackAnalysis(ctx);
  }

  try {
    const url = `${AI_API_BASE_URL.replace(/\/$/, '')}/chat/completions`;

    const resp = await axios.post(
      url,
      {
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'You are a careful SRE incident analyst. Answer clearly and concisely.' },
          { role: 'user',   content: buildPrompt(ctx) },
        ],
        temperature: 0.2,
        max_tokens:  800,
      },
      {
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
          'Content-Type': 'application/json',
          // OpenRouter requires these for free-tier routing
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:5000',
          'X-Title':      process.env.OPENROUTER_TITLE   || 'SRE AI Agent',
        },
        timeout: 25000,
      }
    );

    return resp.data?.choices?.[0]?.message?.content || fallbackAnalysis(ctx);
  } catch (e) {
    console.error('askAI error:', e.response?.data || e.message);
    return fallbackAnalysis(ctx);
  }
}

// ─────────────────────────────────────────────
//  MCP / METRIC ENDPOINTS  (for Claude MCP or direct access)
// ─────────────────────────────────────────────
app.get('/mcp/traffic', async (_req, res) => {
  const [current, baseline] = await Promise.all([
    queryProm('sum(rate(k6_http_reqs_total[1m]))'),
    queryProm('avg_over_time(sum(rate(k6_http_reqs_total[1m]))[10m:1m])'),
  ]);
  res.json({ current_rps: current, baseline_rps: baseline });
});

app.get('/mcp/errors', async (_req, res) => {
  const value = await queryProm('sum(rate(k6_http_req_failed[1m]))');
  res.json({ error_rate: value });
});

app.get('/mcp/latency', async (_req, res) => {
  const value = await queryProm(
    'histogram_quantile(0.95, sum(rate(k6_http_req_duration_bucket[1m])) by (le))'
  );
  res.json({ latency_p95_ms: value });
});

app.get('/mcp/saturation', async (_req, res) => {
  const [cpu, mem, disk] = await Promise.all([
    queryProm('avg(rate(node_cpu_seconds_total{mode!="idle"}[2m])) * 100'),
    queryProm('(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100'),
    queryProm('(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_free_bytes{mountpoint="/"}) / node_filesystem_size_bytes{mountpoint="/"} * 100'),
  ]);
  res.json({ cpu_pct: cpu, memory_pct: mem, disk_pct: disk });
});

// Grafana dashboard helpers
app.get('/mcp/grafana/dashboards', async (_req, res) => {
  res.json(await grafanaGet('/api/search'));
});

app.get('/mcp/grafana/dashboard/:uid', async (req, res) => {
  res.json(await grafanaGet(`/api/dashboards/uid/${req.params.uid}`));
});

// Raw PromQL passthrough
app.get('/mcp/grafana/query', async (req, res) => {
  const expr = req.query.q;
  if (!expr) return res.status(400).json({ error: 'Missing ?q= parameter' });

  try {
    const response = await axios.post(
      `${GRAFANA_URL}/api/ds/query`,
      {
        queries: [{ refId: 'A', datasource: { uid: GRAFANA_DS_UID }, expr, range: true }],
        from: req.query.from || 'now-1h',
        to:   req.query.to   || 'now',
      },
      { headers: grafanaHeaders(), timeout: 12000 }
    );
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
//  MAIN WEBHOOK  — Grafana / Alertmanager → POST /api/analyze
// ─────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const alertPayload = req.body || {};

    // 1. Collect live metrics
    const metrics = await collectMetrics();

    // 2. Build structured context
    const ctx = buildContext(alertPayload, metrics);

    // 3. Ask AI for analysis
    const analysis = await askAI(ctx);

    const output = {
      received:  true,
      alertname: ctx.alertname,
      severity:  ctx.severity,
      service:   ctx.service,
      startsAt:  ctx.startsAt,
      analysis,
      metrics,
      labels:      ctx.labels,
      annotations: ctx.annotations,
    };

    console.log('\n[ALERT]', JSON.stringify(output, null, 2));
    res.status(200).json(output);
  } catch (err) {
    console.error('Analyze endpoint error:', err.message);
    res.status(500).json({ received: false, error: 'Analysis failed', details: err.message });
  }
});

// ─────────────────────────────────────────────
//  TEST ENDPOINT  — simulate each alert type
//  POST /api/test-alert?type=traffic|latency|error|saturation
// ─────────────────────────────────────────────
app.post('/api/test-alert', async (req, res) => {
  const type = req.query.type || 'traffic';

  const alertMap = {
    traffic: {
      alertname: 'HighTrafficSpike',
      severity:  'warning',
      summary:   'Traffic is 3x the 10-minute baseline',
      description: 'Sustained request surge for more than 2 minutes.',
    },
    latency: {
      alertname: 'HighLatency',
      severity:  'critical',
      summary:   'p95 latency exceeded 1500 ms',
      description: 'Tail latency is degraded — possible downstream bottleneck.',
    },
    error: {
      alertname: 'ErrorSpike',
      severity:  'critical',
      summary:   'Error rate exceeded 5%',
      description: 'HTTP 5xx errors spiking across multiple services.',
    },
    saturation: {
      alertname: 'ResourceSaturation',
      severity:  'high',
      summary:   'CPU or memory near saturation',
      description: 'Node resource utilization above 85%.',
    },
  };

  const meta = alertMap[type] || alertMap.traffic;

  const fakePayload = {
    status:   'firing',
    receiver: 'sre-ai-agent',
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: meta.alertname,
          severity:  meta.severity,
          service:   'k6-test',
        },
        annotations: {
          summary:     meta.summary,
          description: meta.description,
        },
        startsAt: new Date().toISOString(),
      },
    ],
  };

  try {
    const metrics  = await collectMetrics();
    const ctx      = buildContext(fakePayload, metrics);
    const analysis = await askAI(ctx);
    res.json({ ok: true, type, analysis, metrics });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    service:      'sre-ai-agent',
    ai_provider:  AI_PROVIDER,
    ai_model:     AI_MODEL,
    grafana_url:  GRAFANA_URL || '(not set)',
    grafana_ds:   GRAFANA_DS_UID || '(not set)',
  });
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nSRE AI Agent  →  http://localhost:${PORT}`);
  console.log(`  Health:      GET  /health`);
  console.log(`  Webhook:     POST /api/analyze`);
  console.log(`  Test alert:  POST /api/test-alert?type=traffic|latency|error|saturation`);
  console.log(`  MCP metrics: GET  /mcp/traffic | /mcp/errors | /mcp/latency | /mcp/saturation`);
  console.log(`  AI provider: ${AI_PROVIDER}  model: ${AI_MODEL}\n`);
});