require('dotenv').config();
const axios = require('axios');

const GRAFANA_URL = process.env.GRAFANA_URL;

// ✅ AI call function
async function callAI(prompt) {
  try {
    const res = await axios.post(
      `${process.env.AI_API_BASE_URL}/chat/completions`,
      {
        model: "nvidia/nemotron-3-super-120b-a12b:free",
        messages: [
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("FULL AI RESPONSE:", res.data); // debug

    const data = res.data;

    return (
      data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.text ||
      "No response from AI"
    );

  } catch (err) {
    console.error("AI Error:", err.response?.data || err.message);
  }
}

async function getDashboard() {
  try {
    const res = await axios.get(
      `${GRAFANA_URL}/api/dashboards/uid/shf6pbx`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GRAFANA_API_KEY}`
        }
      }
    );

    const panels = res.data.dashboard.panels;

    const queries = [];

    panels.forEach(panel => {
      panel.targets?.forEach(t => {
        if (t.expr) {
          queries.push(t.expr);
          console.log("Query:", t.expr);
        }
      });
    });

    console.log("All Queries:", queries);

    // ✅ Prompt with JSON requirement
    const prompt = `
You are a monitoring expert.

For each query:
- Explain it
- Detect anomalies
- Assign severity (Low / Medium / High)
- Suggest an action

Return response STRICTLY in JSON format:
[
  {
    "query": "...",
    "issue": "...",
    "severity": "Low | Medium | High",
    "action": "..."
  }
]

Queries:
${queries.join("\n")}
`;

    console.log("\nGenerated Prompt:\n", prompt);

    // ✅ AI call
    const aiResponse = await callAI(prompt);

    console.log("\nRaw AI Output:\n", aiResponse);

    // ✅ Extract JSON safely (handles ```json blocks or extra text)
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      console.error("❌ No JSON found in AI response");
      return;
    }

    const cleaned = jsonMatch[0];

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("❌ Failed to parse JSON");
      console.error("Cleaned response:", cleaned);
      return;
    }

    console.log("\nParsed AI Analysis:\n", parsed);

    // ✅ Alert logic
    const hasHighSeverity = parsed.some(item =>
      item.severity?.toLowerCase() === "high"
    );

    if (hasHighSeverity) {
      console.log("🚨 ALERT: Critical issue detected");
    } else {
      console.log("✅ No critical issues");
    }

  } catch (err) {
    console.error(
      "Grafana API Error:",
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

// run
(async () => {
  console.log("URL:", GRAFANA_URL);
  await getDashboard();
})();