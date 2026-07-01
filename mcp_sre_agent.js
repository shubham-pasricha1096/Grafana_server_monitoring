const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
require('dotenv').config();
const axios = require('axios');
const path = require('path');

// CONFIG
const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;
const GRAFANA_DS_UID = process.env.GRAFANA_DS_UID;

const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://openrouter.ai/api/v1';
const AI_MODEL = process.env.AI_MODEL || 'mistralai/mistral-7b-instruct:free';

const MCP_SERVER_PATH = path.join(__dirname, 'mcp-grafana', 'dist', 'mcp-grafana.exe');

async function runAgent() {
  console.log("🚀 Starting UPGRADED SRE MCP Agent...");

  // 1. Setup MCP Client
  const transport = new StdioClientTransport({
    command: MCP_SERVER_PATH,
    args: [],
    env: {
      ...process.env,
      GRAFANA_URL,
      GRAFANA_SERVICE_ACCOUNT_TOKEN: GRAFANA_API_KEY,
    }
  });

  const client = new Client({
    name: "sre-agent",
    version: "1.1.0"
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  console.log("✅ Connected to mcp-grafana server");

  // 2. Metric Collection & Analysis Loop
  setInterval(async () => {
    try {
      console.log("\n--- Monitoring Golden Signals (with Granular Breakdown) ---");

      // Fetch Metrics with Label Breakdown
      const queries = {
        traffic: `sum(rate(k6_http_reqs_total[1m])) by (signal)`,
        errors: `sum(rate(k6_http_req_failed_rate[1m])) by (signal)`,
        latency: `avg(k6_http_req_duration_p99) by (signal)`,
        saturation: `sum(k6_vus)`
      };

      const metrics = { breakdown: {} };
      
      for (const [name, expr] of Object.entries(queries)) {
        const result = await client.callTool({
          name: "query_prometheus",
          arguments: {
            expr: expr,
            datasourceUid: GRAFANA_DS_UID,
            endTime: "now",
            queryType: "instant"
          }
        });
        
        const responseData = JSON.parse(result.content[0].text);
        const data = responseData.data || [];

        if (name === 'saturation') {
          metrics.saturation = data[0]?.value?.[1] || 0;
        } else {
          // Store breakdown for traffic, errors, and latency
          metrics.breakdown[name] = data.map(series => ({
            type: series.metric.signal || 'unknown',
            value: series.value[1]
          }));
          
          // Calculate total for simplified logging
          metrics[name] = data.reduce((acc, series) => acc + parseFloat(series.value[1]), 0);
        }
      }

      console.log(`📊 Totals: Traffic=${Number(metrics.traffic).toFixed(2)} req/s, Errors=${Number(metrics.errors).toFixed(2)} %, Latency=${Number(metrics.latency).toFixed(2)} ms, Saturation=${metrics.saturation}`);
      console.log(`🔍 Breakdown by Signal Label:`, JSON.stringify(metrics.breakdown, null, 2));

      // 3. AI Analysis (Updated prompt for granular data)
      const prompt = `You are a Senior SRE. Analyze the following Golden Signals from a system under load test. 
The data includes a breakdown by "signal" label, which corresponds to the test scenario being run.

SYSTEM METRICS:
- Total Traffic: ${metrics.traffic} req/s
- Total Error Rate: ${metrics.errors}%
- Average Latency: ${metrics.latency} ms
- Current Saturation (VUs): ${metrics.saturation}

GRANULAR BREAKDOWN:
${JSON.stringify(metrics.breakdown, null, 2)}

Anomalies to look for:
1. Which specific signal (traffic, latency, error, saturation) is contributing most to the issues?
2. Are errors isolated to a specific traffic type?
3. Is latency spiking only for the "latency" tagged requests?

Provide a concise alert message identifying the specific scenario/scenario(s) causing trouble. If everything is normal, respond ONLY with "OK".`;

      const aiResponse = await axios.post(`${AI_API_BASE_URL}/chat/completions`, {
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }]
      }, {
        headers: {
          'Authorization': `Bearer ${AI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const alert = aiResponse.data.choices[0].message.content.trim();
      if (alert !== "OK") {
        console.log("⚠️  ALERT DETECTED:");
        console.log(alert);

        // 4. Create Grafana Incident
        try {
          const firstLine = alert.split('\n')[0].replace(/[#*]/g, '').trim();
          await client.callTool({
            name: "create_incident",
            arguments: {
              title: `AI Root Cause: ${firstLine.substring(0, 80)}`,
              severity: "warning",
              status: "active",
              roomPrefix: "sre-agent",
              attachCaption: "Granular Anomaly Report",
              attachUrl: GRAFANA_URL
            }
          });
          console.log("🆕 Grafana Incident created with Root Cause analysis.");
        } catch (incidentError) {
          console.error("❌ Failed to create incident:", incidentError.message);
        }
      } else {
        console.log("✅ Status: Normal");
      }

    } catch (error) {
      console.error("❌ Error in agent loop:", error.message);
    }
  }, 30000); // Check every 30 seconds
}

runAgent().catch(err => {
  console.error("💥 Failed to start agent:", err);
  process.exit(1);
});
