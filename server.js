import express from "express";
import WebSocket from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const ELEVEN_TIMEOUT_MS = 20000;
const OPENAI_TIMEOUT_MS = 12000;
const FALLBACK_REPLY =
  "Er ging iets mis met mijn antwoord, kun je je bericht nog een keer sturen";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function clamp(value, max = 500) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
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

function summarizeRecentMessages(recentMessages, limit = 8) {
  return recentMessages.slice(-limit).map((msg) => ({
    role: msg.role || "unknown",
    message_text: clamp(msg.message_text, 250),
    timestamp: msg.timestamp || "",
  }));
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

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;

  const trimmed = value.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

function extractOutputText(response) {
  if (cleanText(response?.output_text)) {
    return cleanText(response.output_text);
  }

  if (Array.isArray(response?.output)) {
    const textParts = [];

    for (const item of response.output) {
      if (!Array.isArray(item?.content)) continue;

      for (const contentItem of item.content) {
        if (
          contentItem?.type === "output_text" &&
          cleanText(contentItem?.text)
        ) {
          textParts.push(cleanText(contentItem.text));
        }
      }
    }

    return cleanText(textParts.join("\n"));
  }

  return "";
}

async function getStructuredUpdates({
  message,
  customerStatus,
  currentPhase,
  currentGoal,
  currentObjections,
  currentLastSummary,
  recentMessages,
}) {
  if (!openai) {
    console.error("OPENAI CONFIG ERROR: OPENAI_API_KEY ontbreekt");
    return {
      goal_update: "",
      objections_update: "",
      last_summary_update: "",
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      goal_update: {
        type: "string",
        description:
          "Alleen invullen als het nieuwste gebruikersbericht een nieuwe of duidelijk concretere doelomschrijving bevat. Anders lege string.",
      },
      objections_update: {
        type: "string",
        description:
          "Alleen invullen als het nieuwste gebruikersbericht een nieuw of duidelijk concreter bezwaar, twijfel, weerstand of koopobstakel bevat. Anders lege string.",
      },
      last_summary_update: {
        type: "string",
        description:
          "Een korte feitelijke samenvatting van relevante nieuwe informatie uit het nieuwste gebruikersbericht. Alleen invullen als er echt relevante nieuwe info is. Anders lege string.",
      },
    },
    required: ["goal_update", "objections_update", "last_summary_update"],
  };

  const systemPrompt = [
    "Je bent een strikte CRM-extractor voor een WhatsApp salesgesprek.",
    "Je taak is NIET om te antwoorden op de gebruiker.",
    "Je analyseert alleen het nieuwste gebruikersbericht in de context van de bestaande gegevens.",
    "",
    "Je moet uitsluitend geldige JSON teruggeven in exact deze vorm:",
    '{ "goal_update": "", "objections_update": "", "last_summary_update": "" }',
    "",
    "Regels:",
    "- Gebruik Nederlands.",
    "- Vul alleen een veld als het nieuwste gebruikersbericht echt relevante nieuwe of duidelijk concretere informatie toevoegt.",
    "- Als er geen relevante update is voor een veld, geef een lege string terug.",
    "- Verzin niets.",
    "- Houd goal_update kort en concreet.",
    "- Houd objections_update kort en concreet.",
    "- Houd last_summary_update compact, feitelijk en bruikbaar voor CRM.",
    "- Geef geen uitleg buiten de JSON.",
  ].join("\n");

  const userPayload = {
    latest_user_message: clamp(message, 1000),
    current_customer_status: cleanText(customerStatus),
    current_phase: cleanText(currentPhase),
    current_goal: cleanText(currentGoal),
    current_objections: cleanText(currentObjections),
    current_last_summary: cleanText(currentLastSummary),
    recent_messages: summarizeRecentMessages(recentMessages),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await openai.responses.create(
      {
        model: process.env.OPENAI_EXTRACTION_MODEL || "gpt-5.4-mini",
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(userPayload) }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "memory_updates",
            strict: true,
            schema,
          },
        },
      },
      {
        signal: controller.signal,
      }
    );

    const rawText = extractOutputText(response);
    const parsed = safeJsonParse(rawText);

    if (!parsed || typeof parsed !== "object") {
      console.error("OPENAI EXTRACTION ERROR: ongeldige JSON output", rawText);
      return {
        goal_update: "",
        objections_update: "",
        last_summary_update: "",
      };
    }

    return {
      goal_update: cleanText(parsed.goal_update),
      objections_update: cleanText(parsed.objections_update),
      last_summary_update: cleanText(parsed.last_summary_update),
    };
  } catch (error) {
    console.error("OPENAI EXTRACTION ERROR:", error?.message || error);
    return {
      goal_update: "",
      objections_update: "",
      last_summary_update: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getElevenReply({
  userId,
  message,
  customerStatus,
  currentPhase,
  goal,
  objections,
  lastSummary,
  recentMessages,
  agentId,
}) {
  return await new Promise((resolve) => {
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
      agentId
    )}`;

    let finalReply = "";
    let settled = false;
    let timeout = null;
    let ws = null;

    const settle = (reply) => {
      if (settled) return;
      settled = true;
      resolve(cleanText(reply) || FALLBACK_REPLY);
    };

    try {
      ws = new WebSocket(wsUrl);

      timeout = setTimeout(() => {
        console.error("ELEVENLABS TIMEOUT: geen reply binnen 20 seconden");
        try {
          ws.close();
        } catch {}
        settle(finalReply || FALLBACK_REPLY);
      }, ELEVEN_TIMEOUT_MS);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              conversation: {
                text_only: true,
              },
            },
            user_id: userId,
          })
        );

        const contextBlock = buildContextBlock({
          customer_status: customerStatus,
          current_phase: currentPhase,
          goal,
          objections,
          last_summary: lastSummary,
          recent_messages: recentMessages,
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
            text: message,
          })
        );
      });

      ws.on("message", (raw) => {
        let data = null;

        try {
          data = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (data.type === "agent_chat_response_part") {
          const partType = data.text_response_part?.type;
          const partText = data.text_response_part?.text || "";

          if (partType === "start" || partType === "delta") {
            finalReply += partText;
          }
        }

        if (data.type === "agent_response") {
          clearTimeout(timeout);

          try {
            ws.close();
          } catch {}

          const reply =
            cleanText(data.agent_response_event?.agent_response) ||
            cleanText(finalReply) ||
            FALLBACK_REPLY;

          settle(reply);
        }
      });

      ws.on("error", (err) => {
        console.error("ELEVENLABS WS ERROR:", err?.message || err);
        clearTimeout(timeout);
        settle(finalReply || FALLBACK_REPLY);
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        if (!settled) {
          settle(finalReply || FALLBACK_REPLY);
        }
      });
    } catch (error) {
      console.error("ELEVENLABS OUTER ERROR:", error?.message || error);
      if (timeout) clearTimeout(timeout);
      settle(finalReply || FALLBACK_REPLY);
    }
  });
}

app.get("/health", (_req, res) => {
  return res.json({ ok: true });
});

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

  const agentId = cleanText(process.env.ELEVENLABS_AGENT_ID);

  const normalizedUserId = cleanText(user_id);
  const normalizedMessage = cleanText(message);
  const normalizedCustomerStatus = cleanText(customer_status);
  const normalizedCurrentPhase = cleanText(current_phase);
  const normalizedGoal = cleanText(goal);
  const normalizedObjections = cleanText(objections);
  const normalizedLastSummary = cleanText(last_summary);
  const normalizedRecentMessages = normalizeRecentMessages(recent_messages);

  console.log("CHAT HIT");
  console.log(
    JSON.stringify(
      {
        user_id: normalizedUserId,
        message: normalizedMessage,
        customer_status: normalizedCustomerStatus,
        current_phase: normalizedCurrentPhase,
        goal: normalizedGoal,
        objections: normalizedObjections,
        last_summary: normalizedLastSummary,
        recent_messages_count: normalizedRecentMessages.length,
      },
      null,
      2
    )
  );

  if (!normalizedUserId) {
    console.error("REQUEST ERROR: user_id ontbreekt");
    return res.json(
      buildResponse({
        reply: FALLBACK_REPLY,
      })
    );
  }

  if (!normalizedMessage) {
    console.error("REQUEST ERROR: message ontbreekt");
    return res.json(
      buildResponse({
        reply: FALLBACK_REPLY,
      })
    );
  }

  if (!agentId) {
    console.error("CONFIG ERROR: ELEVENLABS_AGENT_ID ontbreekt");
    return res.json(
      buildResponse({
        reply: FALLBACK_REPLY,
      })
    );
  }

  try {
    const [replyResult, extractionResult] = await Promise.allSettled([
      getElevenReply({
        userId: normalizedUserId,
        message: normalizedMessage,
        customerStatus: normalizedCustomerStatus,
        currentPhase: normalizedCurrentPhase,
        goal: normalizedGoal,
        objections: normalizedObjections,
        lastSummary: normalizedLastSummary,
        recentMessages: normalizedRecentMessages,
        agentId,
      }),
      getStructuredUpdates({
        message: normalizedMessage,
        customerStatus: normalizedCustomerStatus,
        currentPhase: normalizedCurrentPhase,
        currentGoal: normalizedGoal,
        currentObjections: normalizedObjections,
        currentLastSummary: normalizedLastSummary,
        recentMessages: normalizedRecentMessages,
      }),
    ]);

    const reply =
      replyResult.status === "fulfilled"
        ? cleanText(replyResult.value) || FALLBACK_REPLY
        : FALLBACK_REPLY;

    if (replyResult.status === "rejected") {
      console.error("ELEVENLABS PROMISE ERROR:", replyResult.reason);
    }

    const extraction =
      extractionResult.status === "fulfilled"
        ? extractionResult.value
        : {
            goal_update: "",
            objections_update: "",
            last_summary_update: "",
          };

    if (extractionResult.status === "rejected") {
      console.error("OPENAI PROMISE ERROR:", extractionResult.reason);
    }

    return res.json(
      buildResponse({
        reply,
        goal_update: extraction.goal_update,
        objections_update: extraction.objections_update,
        last_summary_update: extraction.last_summary_update,
      })
    );
  } catch (error) {
    console.error("SERVER ERROR:", error?.message || error);
    return res.json(
      buildResponse({
        reply: FALLBACK_REPLY,
      })
    );
  }
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
