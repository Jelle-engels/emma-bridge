import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { user_id, message } = req.body;

  console.log("CHAT HIT");
  console.log("BODY:", req.body);

  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!agentId) {
    return res.json({ reply: "Agent ID ontbreekt" });
  }

  const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;

  let finalReply = "";
  let finished = false;

  try {
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        console.log("TIMEOUT");
        ws.close();
        res.json({ reply: "Geen antwoord van Emma" });
      }
    }, 15000);

    ws.on("open", () => {
      console.log("WS OPEN");

      ws.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: {
            conversation: {
              text_only: true
            }
          }
        })
      );

      ws.send(
        JSON.stringify({
          type: "user_message",
          text: message
        })
      );
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      console.log("WS RAW:", text);

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.log("JSON PARSE ERROR");
        return;
      }

      if (data.type === "agent_response" && data.agent_response_event?.agent_response) {
        finalReply = data.agent_response_event.agent_response;
      }

      if (data.type === "agent_chat_response_part" && data.text_response_part?.text) {
        finalReply += data.text_response_part.text;
      }

      if (!finished && finalReply.trim()) {
        finished = true;
        clearTimeout(timeout);
        ws.close();
        res.json({ reply: finalReply.trim() });
      }
    });

    ws.on("error", (err) => {
      console.error("WS ERROR:", err);
      if (!finished) {
        finished = true;
        res.json({ reply: "Fout bij verbinden met Emma" });
      }
    });

    ws.on("close", () => {
      console.log("WS CLOSED");
    });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    if (!finished) {
      finished = true;
      res.json({ reply: "Serverfout" });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
