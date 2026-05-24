import express from "express";
import WebSocket from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const ELEVEN_TIMEOUT_MS = Number(process.env.ELEVEN_TIMEOUT_MS || 20000);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 12000);

const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 12000);
const DEBOUNCE_MAX_MESSAGES = Number(process.env.DEBOUNCE_MAX_MESSAGES || 8);
const DEBOUNCE_MAX_AGE_MS = Number(process.env.DEBOUNCE_MAX_AGE_MS || 120000);

const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 12);
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 500);
const MAX_SUMMARY_CHARS = Number(process.env.MAX_SUMMARY_CHARS || 900);
const MAX_GOAL_CHARS = Number(process.env.MAX_GOAL_CHARS || 300);
const MAX_OBJECTIONS_CHARS = Number(process.env.MAX_OBJECTIONS_CHARS || 400);

const NO_REPLY = "__NO_REPLY__";

const FALLBACK_REPLY =
  "Er ging iets mis met mijn antwoord, kun je je bericht nog een keer sturen";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* ----------------------------- BASIC HELPERS ----------------------------- */

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanReplyText(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clamp(value, max = 500) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
}

function normalizeComparableText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildResponse({
  reply,
  goal_update = "",
  objections_update = "",
  last_summary_update = "",
  send_reply,
}) {
  const rawReply = reply === NO_REPLY ? NO_REPLY : cleanReplyText(reply);

  return {
    send_reply:
      typeof send_reply === "boolean"
        ? send_reply
        : rawReply !== "" && rawReply !== NO_REPLY,
    reply: rawReply,
    goal_update: cleanText(goal_update),
    objections_update: cleanText(objections_update),
    last_summary_update: cleanText(last_summary_update),
  };
}

function buildNoReplyResponse() {
  return buildResponse({
    send_reply: false,
    reply: NO_REPLY,
    goal_update: "",
    objections_update: "",
    last_summary_update: "",
  });
}

/* ------------------------ SERVER-SIDE MESSAGE DEBOUNCE -------------------- */

const pendingDebounceByUser = new Map();

function buildDebouncedUserMessage(messages) {
  return messages.map(cleanText).filter(Boolean).join("\n");
}

async function waitForDebouncedUserMessage({ userId, message }) {
  if (!DEBOUNCE_MS || DEBOUNCE_MS <= 0) {
    return {
      shouldProcess: true,
      message: cleanText(message),
      skipped: false,
    };
  }

  const key = cleanText(userId);
  const cleanMessage = cleanText(message);
  const requestId = randomUUID();
  const now = Date.now();

  const existing = pendingDebounceByUser.get(key);

  const entry = existing || {
    latestRequestId: requestId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  entry.latestRequestId = requestId;
  entry.updatedAt = now;

  entry.messages.push({
    requestId,
    message: cleanMessage,
    timestamp: now,
  });

  entry.messages = entry.messages
    .filter((item) => now - item.timestamp <= DEBOUNCE_MAX_AGE_MS)
    .slice(-DEBOUNCE_MAX_MESSAGES);

  pendingDebounceByUser.set(key, entry);

  await sleep(DEBOUNCE_MS);

  const current = pendingDebounceByUser.get(key);

  if (!current || current.latestRequestId !== requestId) {
    return {
      shouldProcess: false,
      message: "",
      skipped: true,
    };
  }

  pendingDebounceByUser.delete(key);

  return {
    shouldProcess: true,
    message: buildDebouncedUserMessage(
      current.messages.map((item) => item.message)
    ),
    skipped: false,
  };
}

setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of pendingDebounceByUser.entries()) {
    if (now - entry.updatedAt > DEBOUNCE_MAX_AGE_MS) {
      pendingDebounceByUser.delete(key);
    }
  }
}, 60000).unref?.();

/* -------------------------- MESSAGE NORMALIZATION ------------------------- */

function normalizeRole(role) {
  const r = cleanText(role).toLowerCase();

  if (["emma", "assistant", "ai", "agent", "bot"].includes(r)) return "emma";

  if (["user", "customer", "klant", "client", "lead", "persoon"].includes(r)) {
    return "user";
  }

  return r || "unknown";
}

function parseTimestamp(value) {
  const raw = cleanText(value);
  if (!raw) return null;

  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function normalizeRecentMessages(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const role = normalizeRole(item?.role || item?.sender || item?.from);
      const message_text = cleanText(
        item?.message_text || item?.message || item?.text || item?.content
      );
      const timestamp = cleanText(
        item?.timestamp || item?.created_at || item?.date || item?.time
      );

      return {
        role,
        message_text,
        timestamp,
        _index: index,
        _time: parseTimestamp(timestamp),
      };
    })
    .filter((item) => item.role || item.message_text || item.timestamp);
}

function sortMessagesChronologically(messages) {
  return [...messages].sort((a, b) => {
    if (a._time !== null && b._time !== null) return a._time - b._time;
    if (a._time !== null) return -1;
    if (b._time !== null) return 1;
    return a._index - b._index;
  });
}

function removeCurrentUserMessageFromHistory(messages, currentMessage) {
  const current = normalizeComparableText(currentMessage);
  if (!current) return messages;

  let removed = false;

  return [...messages]
    .reverse()
    .filter((msg) => {
      if (removed) return true;

      const sameRole = msg.role === "user";
      const sameText = normalizeComparableText(msg.message_text) === current;

      if (sameRole && sameText) {
        removed = true;
        return false;
      }

      return true;
    })
    .reverse();
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

function sanitizeAndPrepareRecentMessages(recentMessages, currentMessage) {
  const normalized = normalizeRecentMessages(recentMessages);
  const sorted = sortMessagesChronologically(normalized);

  const deduped = uniqueBy(sorted, (msg) => {
    const role = msg.role || "unknown";
    const text = normalizeComparableText(msg.message_text);
    const time = msg.timestamp || "";
    return `${role}|${text}|${time}`;
  });

  const withoutCurrentMessage = removeCurrentUserMessageFromHistory(
    deduped,
    currentMessage
  );

  return withoutCurrentMessage
    .filter((msg) => msg.message_text)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((msg) => ({
      role: msg.role || "unknown",
      message_text: clamp(msg.message_text, MAX_MESSAGE_CHARS),
      timestamp: msg.timestamp || "",
    }));
}

function getLastEmmaMessages(messages, limit = 3) {
  return messages
    .filter((msg) => msg.role === "emma" && msg.message_text)
    .slice(-limit)
    .map((msg) => msg.message_text);
}

function hasWhatsappGroupLinkBeenSent(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /chat\.whatsapp\.com/i.test(cleanText(msg.message_text))
  );
}

function isCustomerStatusValidated(customerStatus, recentMessages) {
  return (
    cleanText(customerStatus).toLowerCase() === "customer" ||
    hasWhatsappGroupLinkBeenSent(recentMessages)
  );
}

/* ------------------------------ CONTEXT BLOCK ----------------------------- */

function detectState({
  currentMessage,
  recentMessages,
  lastSummary,
  currentPhase,
  customerStatus = "",
}) {
  const hasPreviousEmmaMessage = recentMessages.some(
    (msg) => msg.role === "emma"
  );

  const isExistingConversation =
    hasPreviousEmmaMessage || Boolean(cleanText(lastSummary));

  const latest = cleanText(currentMessage).toLowerCase();

  const hasMedicalTrigger =
    /\b(medicatie|medicijnen|zwanger|borstvoeding|diabetes|hart|lever|nieren|darmziekte|eetstoornis|arts|apotheker|veilig bij|mag dit met)\b/i.test(
      latest
    );

  const hasPurchaseClaim =
    /\b(besteld|order|ordernummer|betaald|gekocht|whatsapp.?groep|groep|toegang|gestart)\b/i.test(
      latest
    );

  const hasExplicitBuyingIntent =
    /\b(bestellen|starten|ik wil starten|hoe bestel|link|kopen|aanschaffen|doorgaan)\b/i.test(
      latest
    );

  const isValidatedCustomer = isCustomerStatusValidated(
    customerStatus,
    recentMessages
  );

  return {
    is_existing_conversation: isExistingConversation,
    has_previous_emma_message: hasPreviousEmmaMessage,
    has_medical_trigger: hasMedicalTrigger,
    has_purchase_claim: hasPurchaseClaim,
    has_explicit_buying_intent: hasExplicitBuyingIntent,
    is_validated_customer: isValidatedCustomer,
    should_use_coaching_mode: isValidatedCustomer,
    current_phase: isValidatedCustomer ? "coaching" : cleanText(currentPhase),
  };
}

function buildContextBlock({
  customer_status,
  current_phase,
  goal,
  objections,
  last_summary,
  recent_messages,
  latest_user_message,
}) {
  const state = detectState({
    currentMessage: latest_user_message,
    recentMessages: recent_messages,
    lastSummary: last_summary,
    currentPhase: current_phase,
    customerStatus: customer_status,
  });

  const context = {
    agent_name: "Emma",
    runtime_state: state,
    crm_memory: {
      customer_status: state.is_validated_customer
        ? "customer"
        : cleanText(customer_status),
      current_phase: state.is_validated_customer
        ? "coaching"
        : cleanText(current_phase),
      goal: clamp(goal, MAX_GOAL_CHARS),
      objections: clamp(objections, MAX_OBJECTIONS_CHARS),
      last_summary: clamp(last_summary, MAX_SUMMARY_CHARS),
    },
    latest_user_message: clamp(latest_user_message, 1000),
    recent_conversation_history: recent_messages.map((msg) => ({
      role: msg.role,
      message_text: clamp(msg.message_text, MAX_MESSAGE_CHARS),
      timestamp: msg.timestamp || "",
    })),
    do_not_repeat_recent_emma_messages: getLastEmmaMessages(recent_messages, 3),
  };

  return [
    "RUNTIME CONTEXT VOOR EMMA",
    "Gebruik deze context als feitelijke achtergrondinformatie. Herhaal deze context niet letterlijk.",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

/* ----------------------------- JSON UTILITIES ----------------------------- */

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
  if (cleanText(response?.output_text)) return cleanText(response.output_text);

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

/* -------------------------- OPENAI CRM EXTRACTION ------------------------- */

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
      goal_update: { type: "string" },
      objections_update: { type: "string" },
      last_summary_update: { type: "string" },
    },
    required: ["goal_update", "objections_update", "last_summary_update"],
  };

  const systemPrompt = [
    "Je bent een strikte CRM-extractor voor een WhatsApp-gesprek.",
    "Je taak is niet om te antwoorden op de gebruiker.",
    "Je analyseert alleen het nieuwste gebruikersbericht in de context van bestaande CRM-data.",
    "Je geeft uitsluitend geldige JSON terug.",
    "Gebruik Nederlands.",
    "Vul alleen een veld als het nieuwste gebruikersbericht echt nieuwe of concretere informatie toevoegt.",
    "Herhaal geen informatie die al in current_goal, current_objections of current_last_summary staat.",
    "Als er geen relevante update is voor een veld, geef een lege string terug.",
    "Verzin niets.",
  ].join("\n");

  const userPayload = {
    latest_user_message: clamp(message, 1000),
    current_customer_status: cleanText(customerStatus),
    current_phase: cleanText(currentPhase),
    current_goal: clamp(currentGoal, MAX_GOAL_CHARS),
    current_objections: clamp(currentObjections, MAX_OBJECTIONS_CHARS),
    current_last_summary: clamp(currentLastSummary, MAX_SUMMARY_CHARS),
    recent_messages: recentMessages.slice(-8).map((msg) => ({
      role: msg.role || "unknown",
      message_text: clamp(msg.message_text, 250),
      timestamp: msg.timestamp || "",
    })),
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
      { signal: controller.signal }
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

/* ----------------------------- ELEVENLABS CHAT ---------------------------- */

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
      resolve(cleanReplyText(reply) || FALLBACK_REPLY);
    };

    try {
      ws = new WebSocket(wsUrl);

      timeout = setTimeout(() => {
        console.error("ELEVENLABS TIMEOUT: geen reply binnen deadline");
        try {
          ws.close();
        } catch {}
        settle(finalReply || FALLBACK_REPLY);
      }, ELEVEN_TIMEOUT_MS);

      ws.on("open", () => {
        const contextBlock = buildContextBlock({
          customer_status: customerStatus,
          current_phase: currentPhase,
          goal,
          objections,
          last_summary: lastSummary,
          recent_messages: recentMessages,
          latest_user_message: message,
        });

        ws.send(
          JSON.stringify({
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              conversation: { text_only: true },
            },
            user_id: userId,
          })
        );

        ws.send(
          JSON.stringify({
            type: "contextual_update",
            text: contextBlock,
          })
        );

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
            cleanReplyText(data.agent_response_event?.agent_response) ||
            cleanReplyText(finalReply) ||
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

/* -------------------------------- ROUTES -------------------------------- */

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
  const originalMessage = cleanText(message);
  const normalizedCustomerStatus = cleanText(customer_status);
  const normalizedCurrentPhase = cleanText(current_phase);
  const normalizedGoal = clamp(goal, MAX_GOAL_CHARS);
  const normalizedObjections = clamp(objections, MAX_OBJECTIONS_CHARS);
  const normalizedLastSummary = clamp(last_summary, MAX_SUMMARY_CHARS);

  if (!normalizedUserId) {
    console.error("REQUEST ERROR: user_id ontbreekt");
    return res.json(buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }

  if (!originalMessage) {
    console.error("REQUEST ERROR: message ontbreekt");
    return res.json(buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }

  const debounced = await waitForDebouncedUserMessage({
    userId: normalizedUserId,
    message: originalMessage,
  });

  if (!debounced.shouldProcess) {
    return res.json(buildNoReplyResponse());
  }

  const normalizedMessage = cleanText(debounced.message || originalMessage);

  if (!normalizedMessage) {
    return res.json(buildNoReplyResponse());
  }

  const normalizedRecentMessages = sanitizeAndPrepareRecentMessages(
    recent_messages,
    normalizedMessage
  );

  if (!agentId) {
    console.error("CONFIG ERROR: ELEVENLABS_AGENT_ID ontbreekt");
    return res.json(buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }

  try {
    const alreadyValidated = isCustomerStatusValidated(
      normalizedCustomerStatus,
      normalizedRecentMessages
    );

    const effectiveCustomerStatus = alreadyValidated
      ? "customer"
      : normalizedCustomerStatus;

    const effectiveCurrentPhase = alreadyValidated
      ? "coaching"
      : normalizedCurrentPhase;

    const [replyResult, extractionResult] = await Promise.allSettled([
      getElevenReply({
        userId: normalizedUserId,
        message: normalizedMessage,
        customerStatus: effectiveCustomerStatus,
        currentPhase: effectiveCurrentPhase,
        goal: normalizedGoal,
        objections: normalizedObjections,
        lastSummary: normalizedLastSummary,
        recentMessages: normalizedRecentMessages,
        agentId,
      }),
      getStructuredUpdates({
        message: normalizedMessage,
        customerStatus: effectiveCustomerStatus,
        currentPhase: effectiveCurrentPhase,
        currentGoal: normalizedGoal,
        currentObjections: normalizedObjections,
        currentLastSummary: normalizedLastSummary,
        recentMessages: normalizedRecentMessages,
      }),
    ]);

    const reply =
      replyResult.status === "fulfilled"
        ? cleanReplyText(replyResult.value) || FALLBACK_REPLY
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
        send_reply: true,
        reply,
        goal_update: extraction.goal_update,
        objections_update: extraction.objections_update,
        last_summary_update: extraction.last_summary_update,
      })
    );
  } catch (error) {
    console.error("SERVER ERROR:", error?.message || error);
    return res.json(buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
