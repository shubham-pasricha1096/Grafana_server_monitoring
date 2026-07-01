require('dotenv').config();
const axios = require('axios');

(async () => {
  try {
    const res = await axios.post(
      `${process.env.AI_API_BASE_URL}/chat/completions`,
      {
        model: process.env.AI_MODEL,
        messages: [
          {
            role: "user",
            content: "Say hello"
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(res.data.choices[0].message.content);

  } catch (err) {
    console.error(err.response?.data || err.message);
  }
})();