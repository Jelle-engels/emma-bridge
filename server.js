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

function normalizeCompare(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasDigits(text) {
  return /\d/.test(cleanText(text));
}

function preferMoreSpecific(oldValue, newValue) {
  const oldClean = cleanText(oldValue);
  const newClean = cleanText(newValue);

  if (!newClean) return "";
  if (!oldClean) return newClean;

  const oldNorm = normalizeCompare(oldClean);
  const newNorm = normalizeCompare(newClean);

  if (!newNorm || newNorm === oldNorm) return "";

  if (newNorm.includes(oldNorm) && newNorm.length > oldNorm.length) {
    return newClean;
  }

  if (oldNorm.includes(newNorm)) {
    return "";
  }

  const oldHasDigits = hasDigits(oldClean);
  const newHasDigits = hasDigits(newClean);

  if (newHasDigits && !oldHasDigits) {
    return newClean;
  }

  if (newClean.length > oldClean.length + 10) {
    return newClean;
  }

  return newClean;
}

function extractGoal(message) {
  const text = cleanText(message);
  const lower = text.toLowerCase();

  const patterns = [
    /ik wil\s+([\s\S]{0,80})/i,
    /mijn doel is\s+([\s\S]{0,80})/i,
    /doel is\s+([\s\S]{0,80})/i,
  ];

  for (const p of patterns) {
    const match = text.match(p);
    if (match?.[1]) {
      const val = cleanText(match[1]);
      return val.length > 120 ? val.slice(0, 120) : val;
    }
  }

  const signals = [
    "afvallen",
    "gewicht verliezen",
    "kilo kwijt",
    "gezonder leven",
    "meer energie",
  ];

  for (const s of signals) {
    if (lower.includes(s)) return text.slice(0, 120);
  }

  return "";
}

function extractObjections(message) {
  const lower = cleanText(message).toLowerCase();

  const list = [];

  if (lower.includes("prijs") || lower.includes("duur")) {
    list.push("prijs");
  }
  if (lower.includes("geen tijd") || lower.includes("druk")) {
    list.push("tijdgebrek");
  }
  if (lower.includes("twijfel")) {
    list.push("twijfel");
  }
  if (lower.includes("eerder geprobeerd")) {
    list.push("eerder geprobeerd zonder resultaat");
  }

  return list.join("; ");
}

function extractSummary(message, goalUpdate, objectionsUpdate) {
  const parts = [];

  if (goalUpdate) parts.push(`doel: ${goalUpdate}`);
  if (objectionsUpdate) parts.push(`bezwaar: ${objectionsUpdate}`);

  const text = cleanText(message);

  if (/\d/.test(text)) {
    parts.push(text.slice(0, 80));
  }

  return parts.join("; ");
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

  const agentId = process.env.ELEVENLABS_AGENT_ID;

  const normalizedUserId = cleanText(user_id);
  const normalizedMessage = cleanText(message);

  const normalizedGoal = cleanText(goal);
  const normalizedObjections = cleanText(objections);
  const normalizedLastSummary = cleanText(last_summary);

  const normalizedRecentMessages = normalizeRecentMessages(recent_messages);

  if (!agentId) {
    return res.json(buildResponse({ reply: "Agent ID ontbreekt" }));
  }

  if (!normalizedUserId) {
    return res.json(buildResponse({ reply: "user_id ontbreekt" }));
  }

  if (!normalizedMessage) {
    return res.json(buildResponse({ reply: "message ontbreekt" }));
  }

  const proposedGoal = extractGoal(normalizedMessage);
  const proposedObjections = extractObjections(normalizedMessage);

  const goalUpdate = preferMoreSpecific(normalizedGoal, proposedGoal);
  const objectionsUpdate = preferMoreSpecific(normalizedObjections, proposedObjections);
  const summaryUpdate = extractSummary(normalizedMessage, goalUpdate, objectionsUpdate);

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
        ws.close();
        return safeRespond(
          buildResponse({
            reply: finalReply || "Geen antwoord",
            goal_update: goalUpdate,
            objections_update: objectionsUpdate,
            last_summary_update: summaryUpdate,
          })
        );
      }
    }, 20000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        user_id: normalizedUserId,
      }));

      const context = buildContextBlock({
        customer_status,
        current_phase,
        goal,
        objections,
        last_summary,
        recent_messages: normalizedRecentMessages,
      });

      if (context) {
        ws.send(JSON.stringify({
          type: "contextual_update",
          text: context,
        }));
      }

      ws.send(JSON.stringify({
        type: "user_message",
        text: normalizedMessage,
      }));
    });

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.type === "agent_chat_response_part") {
        const part = data.text_response_part?.text || "";
        finalReply += part;
      }

      if (data.type === "agent_response" && !finished) {
        clearTimeout(timeout);
        ws.close();

        return safeRespond(
          buildResponse({
            reply: finalReply || "Geen antwoord",
            goal_update: goalUpdate,
            objections_update: objectionsUpdate,
            last_summary_update: summaryUpdate,
          })
        );
      }
    });

    ws.on("error", () => {
      return safeRespond(
        buildResponse({
          reply: "Fout",
          goal_update: goalUpdate,
          objections_update: objectionsUpdate,
          last_summary_update: summaryUpdate,
        })
      );
    });

  } catch {
    return safeRespond(
      buildResponse({
        reply: "Serverfout",
        goal_update: goalUpdate,
        objections_update: objectionsUpdate,
        last_summary_update: summaryUpdate,
      })
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
