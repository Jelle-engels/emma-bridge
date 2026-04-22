import express from "express";
import WebSocket from "ws";

const app = express();
app.use(express.json({ limit: "1mb" }));

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeRecentMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      role: cleanText(item?.role),
      message_text: cleanText(item?.message_text),
      timestamp: cleanText(item?.timestamp),
    }))
    .filter((item) => item.role || item.message_text || item.timestamp);
}

function buildContextBlock({
  customer_status,
  current_phase,
  goal,
  objections,
  last_summary,
  recent_messages,
}) {
  const lines = [];

  if (customer_status) lines.push(`Customer status: ${customer_status}`);
  if (current_phase) lines.push(`Current phase: ${current_phase}`);
  if (goal) lines.push(`Goal: ${goal}`);
  if (objections) lines.push(`Objections: ${objections}`);
  if (last_summary) lines.push(`Previous summary: ${last_summary}`);

  if (recent_messages.length > 0) {
    lines.push("Recent conversation history:");
    for (const msg of recent_messages) {
      const role = msg.role || "unknown";
      const text = msg.message_text || "";
      const timestamp = msg.timestamp ? ` (${msg.timestamp})` : "";
      lines.push(`- ${role}${timestamp}: ${text}`);
    }
  }

  return lines.join("\n");
}

function buildResponse({
  reply,
  goal_update = "",
  objections_update = "",
  last_summary_update = "",
}) {
  return {
    reply: cleanText(reply),
    goal_update: cleanText(goal_update),
    objections_update: cleanText(objections_update),
    last_summary_update: cleanText(last_summary_update),
  };
}

app.post("/chat", async (req, res) => {
  const {
    user_id,
    message,
    customer_status = "",
    current_phase = "",
    goal = "",
    objections = "",
    last_summary = "",
    recent_messages = [],
  } = req.body ?? {};

  console.log("CHAT HIT");
  console.log("BODY:", req.body);

  const agentId = process.env.ELEVENLABS_AGENT_ID;

  if (!agentId) {
    return res.json(
      buildResponse({
        reply: "Agent ID ontbreekt",
      })
    );
  }

  const normalizedUserId = cleanText(user_id);
  const normalizedMessage = cleanText(message);
  const normalizedCustomerStatus = cleanText(customer_status);
  const normalizedCurrentPhase = cleanText(current_phase);
  const normalizedGoal = cleanText(goal);
  const normalizedObjections = cleanText(objections);
  const normalizedLastSummary = cleanText(last_summary);
  const normalizedRecentMessages = normalizeRecentMessages(recent_messages);

  if (!normalizedUserId) {
    return res.json(
      buildResponse({
        reply: "user_id ontbreekt",
      })
    );
  }

  if (!normalizedMessage) {
    return res.json(
      buildResponse({
        reply: "message ontbreekt",
      })
    );
  }

  const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;

  let finalReply = "";
  let finished = false;

  const safeRespond = (payload) => {
    if (finished) return;
    finished = true;
    return res.json(payload);
  };

  try {
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      if (!finished) {
        console.log("TIMEOUT");
        try {
          ws.close();
        } catch {}
        return safeRespond(
          buildResponse({
            reply: finalReply.trim() || "Geen antwoord van Emma",
          })
        );
      }
    }, 20000);

    ws.on("open", () => {
      console.log("WS OPEN");

      ws.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: {
            conversation: { text_only: true },
          },
          user_id: normalizedUserId,
        })
      );

      const contextBlock = buildContextBlock({
        customer_status: normalizedCustomerStatus,
        current_phase: normalizedCurrentPhase,
        goal: normalizedGoal,
        objections: normalizedObjections,
        last_summary: normalizedLastSummary,
        recent_messages: normalizedRecentMessages,
      });

      if (contextBlock) {
        ws.send(
          JSON.stringify({
            type: "contextual_update",
            text: contextBlock,
          })
        );
      }

      ws.send(
        JSON.stringify({
          type: "user_message",
          text: normalizedMessage,
        })
      );
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      console.log("WS RAW:", text);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }

      if (
        data.type === "agent_response" &&
        data.agent_response_event?.agent_response &&
        !finished
      ) {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}

        const reply =
          cleanText(data.agent_response_event.agent_response) ||
          "Geen antwoord van Emma";

        console.log("FINAL REPLY:", reply);

        return safeRespond(
          buildResponse({
            reply,
            goal_update: "",
            objections_update: "",
            last_summary_update: "",
          })
        );
      }

      if (data.type === "agent_chat_response_part") {
        const partType = data.text_response_part?.type;
        const partText = data.text_response_part?.text || "";

        if (partType === "start" || partType === "delta") {
          finalReply += partText;
        }
      }
    });

    ws.on("error", (err) => {
      console.error("WS ERROR:", err);
      return safeRespond(
        buildResponse({
          reply: finalReply.trim() || "Fout bij verbinden met Emma",
        })
      );
    });

    ws.on("close", () => {
      console.log("WS CLOSED");
    });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    return safeRespond(
      buildResponse({
        reply: finalReply.trim() || "Serverfout",
      })
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
