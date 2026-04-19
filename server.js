import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { user_id, message } = req.body;

  console.log("CHAT HIT");
  console.log("BODY:", req.body);
  console.log("USER ID:", user_id);
  console.log("MESSAGE:", message);

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        agent_id: process.env.ELEVENLABS_AGENT_ID,
        messages: [
          {
            role: "user",
            content: message
          }
        ]
      })
    });

    console.log("ELEVENLABS STATUS:", response.status);

    const rawText = await response.text();
    console.log("ELEVENLABS RAW RESPONSE:", rawText);

    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (parseError) {
      console.error("JSON PARSE ERROR:", parseError);
    }

    const reply =
      data?.choices?.[0]?.message?.content ||
      "Geen antwoord van Emma";

    console.log("FINAL REPLY:", reply);

    res.json({ reply });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    res.json({ reply: "Fout bij ophalen antwoord" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
