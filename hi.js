const axios = require("axios");

async function testMCP() {
  const res = await axios.post("http://localhost:3000/tools/call", {
    name: "list_dashboards",
    arguments: {}
  });

  console.log(res.data);
}

testMCP();