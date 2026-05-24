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

const WHATSAPP_GROUP_LINK =
  "https://chat.whatsapp.com/IlulN0LkWTFA5T4G1klynS?mode=gi_t";

const FALLBACK_REPLY =
  "Er ging iets mis met mijn antwoord, kun je je bericht nog een keer sturen";

const COACH_SOURCE_START_REPLY =
  "Hallo, ik ben Emma 😊\n\n" +
  "Ik ben de AI-assistent van Nutrition Works en ik help dagelijks mensen om hun doelen te bereiken 🤗✨\n\n" +
  "We hebben al tienduizenden mensen geholpen en ik denk echt dat ik jou ook kan helpen 💚\n\n" +
  "Om je zo goed mogelijk te helpen, mag je me meteen wat meer vertellen over jouw situatie 🙏\n\n" +
  "Bijvoorbeeld:\n" +
  "• je huidige gewicht\n" +
  "• waar je naartoe wil\n" +
  "• je leeftijd\n" +
  "• wat je al geprobeerd hebt\n" +
  "• waar je nu tegenaan loopt\n\n" +
  "Hoe meer je deelt, hoe beter ik je kan helpen 🤗";

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

function removePromptLeakTerms(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/\bneutrale afsluiting\b/gi, "")
    .replace(/\bkorte erkenning\b/gi, "")
    .replace(/\bduidelijke afbakening\b/gi, "")
    .replace(/\bdoorverwijzing\b/gi, "")
    .replace(/\bzonder verkoopdruk\b/gi, "")
    .replace(/\bstructuur van het antwoord\b/gi, "")
    .replace(/\bmedische trigger\b/gi, "")
    .replace(/\bmedical trigger\b/gi, "")
    .replace(/\bsalesflow\b/gi, "")
    .replace(/\bexit-conditie\b/gi, "")
    .replace(/\bexit conditie\b/gi, "")
    .replace(/\bcontextblok\b/gi, "")
    .replace(/\bruntime context\b/gi, "")
    .replace(/\bruntime_state\b/gi, "")
    .replace(/\bcrm_memory\b/gi, "")
    .replace(/\brepetition_guard\b/gi, "")
    .replace(/\blatest_user_message\b/gi, "")
    .replace(/\brecent_conversation_history\b/gi, "");
}

function cleanReplyText(value) {
  if (value === null || value === undefined) return "";

  return removePromptLeakTerms(value)
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

function buildResponse({
  reply,
  goal_update = "",
  objections_update = "",
  last_summary_update = "",
  send_reply,
}) {
  const cleanedReply = cleanReplyText(reply);

  return {
    send_reply:
      typeof send_reply === "boolean" ? send_reply : Boolean(cleanedReply),
    reply: cleanedReply,
    goal_update: cleanText(goal_update),
    objections_update: cleanText(objections_update),
    last_summary_update: cleanText(last_summary_update),
  };
}

/* ------------------------ SERVER-SIDE MESSAGE DEBOUNCE -------------------- */

const pendingDebounceByUser = new Map();

function buildDebouncedUserMessage(messages) {
  const cleanedMessages = messages.map(cleanText).filter(Boolean);

  const nonCoachMessages = cleanedMessages.filter(
    (message) => !isCoachSourceCode(message)
  );

  if (nonCoachMessages.length === 0) {
    return cleanedMessages[cleanedMessages.length - 1] || "";
  }

  return nonCoachMessages.join("\n");
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

  if (["emma", "assistant", "ai", "agent", "bot"].includes(r)) {
    return "emma";
  }

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

function getLastUserMessages(messages, limit = 3) {
  return messages
    .filter((msg) => msg.role === "user" && msg.message_text)
    .slice(-limit)
    .map((msg) => msg.message_text);
}

function hasLinkBeenSent(messages, linkPart) {
  const needle = cleanText(linkPart).toLowerCase();
  if (!needle) return false;

  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      cleanText(msg.message_text).toLowerCase().includes(needle)
  );
}

function hasPriceBeenMentioned(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /€\s*123|123\s*euro|programma kost/i.test(msg.message_text)
  );
}

function hasCheckoutLinkBeenSent(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /bestellen-nl-control-1x|bestellen-be-control-1x/i.test(msg.message_text)
  );
}

function hasWhatsappGroupLinkBeenSent(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /chat\.whatsapp\.com/i.test(msg.message_text)
  );
}

function hasAskedCountry(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /nederland of belgi[eë]|welk land|in welk land/i.test(msg.message_text)
  );
}

function hasAskedOrderNumber(messages) {
  return messages.some(
    (msg) => msg.role === "emma" && /ordernummer/i.test(msg.message_text)
  );
}

function isCustomerStatusValidated(customerStatus, recentMessages) {
  return (
    cleanText(customerStatus).toLowerCase() === "customer" ||
    hasWhatsappGroupLinkBeenSent(recentMessages)
  );
}

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
    /\b(besteld|order|ordernummer|betaald|gekocht|whatsapp.?groep|groep|toegang)\b/i.test(
      latest
    );

  const hasExplicitBuyingIntent =
    /\b(bestellen|starten|ik wil starten|hoe bestel|link|kopen|aanschaffen|doorgaan)\b/i.test(
      latest
    );

  const lowIntent =
    /^(ok|oke|ja|nee|weet niet|misschien|kan|vertel maar|hoe bedoel je|prima|goed|klinkt goed)\.?$/i.test(
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
    is_low_intent: lowIntent,
    is_validated_customer: isValidatedCustomer,
    should_use_coaching_mode: isValidatedCustomer,
    current_phase: isValidatedCustomer ? "coaching" : cleanText(currentPhase),
  };
}

/* --------------------------- COACH SOURCE CODE ---------------------------- */

function isCoachSourceCode(message) {
  const text = cleanText(message);
  return /^coach-[a-zÀ-ÿ0-9_-]+$/i.test(text);
}

function handleCoachSourceCodeIfNeeded(message) {
  if (!isCoachSourceCode(message)) {
    return null;
  }

  return buildResponse({
    send_reply: true,
    reply: COACH_SOURCE_START_REPLY,
  });
}

/* --------------------------- ORDER VALIDATION ----------------------------- */

function isOrderControlTrigger(message) {
  const text = cleanText(message).toLowerCase();

  return /\b(besteld|betaald|gekocht|order|ordernummer|whatsapp.?groep|groep|toegang|gestart)\b/i.test(
    text
  );
}

function isExplicitGroupAccessRequest(message) {
  const text = cleanText(message).toLowerCase();

  return /\b(whatsapp.?groep|groep|toegang|link.*groep|groepslink|groep.*link)\b/i.test(
    text
  );
}

function looksLikeOrderNumber(message) {
  const text = cleanText(message);
  if (!text) return false;

  if (/\b[A-Z0-9-_]*JP[A-Z0-9-_]*\b/i.test(text)) return true;

  return false;
}

function recentEmmaRequestedOrderNumber(recentMessages) {
  return recentMessages.some((msg) => {
    if (msg.role !== "emma") return false;

    const text = cleanText(msg.message_text).toLowerCase();

    return (
      /ordernummer.*nodig/i.test(text) ||
      /ordernummer.*doorsturen/i.test(text) ||
      /ordernummer.*delen/i.test(text) ||
      /stuur.*ordernummer/i.test(text) ||
      /order.*nummer.*nodig/i.test(text)
    );
  });
}

function extractPossibleOrderNumber(message) {
  const text = cleanText(message);
  if (!text) return "";

  const candidates = text.match(/\b[A-Z0-9][A-Z0-9-_]{3,}\b/gi) || [];

  const withJp = candidates.find((candidate) => /JP/i.test(candidate));
  if (withJp) return withJp;

  return "";
}

function isValidOrderNumber(orderNumber) {
  return /JP/i.test(cleanText(orderNumber));
}

function handleOrderControlIfNeeded(message, recentMessages = []) {
  const alreadyValidated = hasWhatsappGroupLinkBeenSent(recentMessages);

  const hasOrderTrigger = isOrderControlTrigger(message);
  const hasPossibleOrderNumber = looksLikeOrderNumber(message);
  const wasAskedForOrderNumber = recentEmmaRequestedOrderNumber(recentMessages);
  const explicitGroupAccessRequest = isExplicitGroupAccessRequest(message);

  const orderNumber = extractPossibleOrderNumber(message);

  if (alreadyValidated) {
    if (explicitGroupAccessRequest) {
      return buildResponse({
        send_reply: true,
        reply: `Je bent al goedgekeurd 🙏\n\nHier is de WhatsApp-groep nog een keer:\n${WHATSAPP_GROUP_LINK}`,
      });
    }

    if (hasPossibleOrderNumber && orderNumber && !isValidOrderNumber(orderNumber)) {
      return buildResponse({
        send_reply: true,
        reply:
          "Je bestelling is al verwerkt. Ik ga vanaf hier gewoon met je meekijken als coach 🙏",
      });
    }

    return null;
  }

  const shouldHandleOrderControl =
    hasOrderTrigger ||
    hasPossibleOrderNumber ||
    (wasAskedForOrderNumber && hasPossibleOrderNumber);

  if (!shouldHandleOrderControl) {
    return null;
  }

  if (!orderNumber) {
    return buildResponse({
      send_reply: true,
      reply: "Om je goed te kunnen helpen heb ik eerst even je ordernummer nodig 🙏",
    });
  }

  if (!isValidOrderNumber(orderNumber)) {
    return buildResponse({
      send_reply: true,
      reply: "Zou je het ordernummer nog eens willen controleren?",
    });
  }

  return buildResponse({
    send_reply: true,
    reply: `Top, je ordernummer is goedgekeurd 🙏\n\nHier is de WhatsApp-groep waar je direct kunt starten met tips en begeleiding:\n${WHATSAPP_GROUP_LINK}`,
  });
}

/* ------------------------------ CONTEXT BLOCK ----------------------------- */

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

  const lastEmmaMessages = getLastEmmaMessages(recent_messages, 3);
  const lastUserMessages = getLastUserMessages(recent_messages, 3);

  const testimonialAlreadySent = hasLinkBeenSent(
    recent_messages,
    "youtube.com/@Nutrition-Works"
  );

  const priceAlreadyMentioned = hasPriceBeenMentioned(recent_messages);
  const checkoutLinkAlreadySent = hasCheckoutLinkBeenSent(recent_messages);
  const whatsappGroupLinkAlreadySent = hasWhatsappGroupLinkBeenSent(recent_messages);
  const countryAlreadyAsked = hasAskedCountry(recent_messages);
  const orderNumberAlreadyAsked = hasAskedOrderNumber(recent_messages);

  const validatedCustomer = isCustomerStatusValidated(
    customer_status,
    recent_messages
  );

  const context = {
    agent_name: "Emma",
    runtime_state: {
      ...state,
      testimonial_already_sent: testimonialAlreadySent,
      price_already_mentioned: priceAlreadyMentioned,
      checkout_link_already_sent: checkoutLinkAlreadySent,
      whatsapp_group_link_already_sent: whatsappGroupLinkAlreadySent,
      country_already_asked: countryAlreadyAsked,
      order_number_already_asked: orderNumberAlreadyAsked,
      order_validation_server_side: true,
    },
    crm_memory: {
      customer_status: validatedCustomer ? "customer" : cleanText(customer_status),
      current_phase: validatedCustomer ? "coaching" : cleanText(current_phase),
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
    repetition_guard: {
      do_not_repeat_these_recent_emma_messages: lastEmmaMessages,
      last_user_messages_for_context_only: lastUserMessages,
      rules: [
        "Antwoord alleen op het nieuwste klantbericht.",
        "Gebruik bekende CRM-data als achtergrond, niet als tekst om opnieuw op te sommen.",
        "Herhaal geen vraag, uitleg, prijs, testimonial-link, checkout-link of ordernummer-instructie die al in de recente Emma-berichten staat.",
        "Als iets al bekend is uit goal, objections, last_summary of recent_conversation_history: vraag er niet opnieuw naar.",
        "Als het gesprek bestaand is: stel jezelf niet opnieuw voor en gebruik geen startbericht.",
        "Als testimonial_already_sent true is: stuur de testimonial-link niet opnieuw, tenzij de klant er expliciet om vraagt.",
        "Als price_already_mentioned true is: noem de prijs niet opnieuw, tenzij de klant ernaar vraagt.",
        "Als country_already_asked true is: vraag niet opnieuw naar Nederland of België, tenzij het antwoord nog ontbreekt en het direct nodig is voor checkout.",
        "Als checkout_link_already_sent true is: stuur geen nieuwe checkout-link, tenzij de klant er expliciet opnieuw om vraagt.",
        "Als whatsapp_group_link_already_sent true is: behandel de klant als gevalideerde klant en ga over naar coachingsmodus.",
        "In coachingsmodus: geen salesflow, geen prijs, geen checkout, geen nieuwe ordernummer-vraag, tenzij de klant expliciet opnieuw naar de WhatsApp-groep of toegang vraagt.",
        "Ordervalidatie wordt server-side uitgevoerd. Emma mag nooit zelf een ordernummer goedkeuren of de WhatsApp-link zelfstandig delen.",
        "Gebruik nooit interne prompttermen zoals neutrale afsluiting, medische trigger, salesflow, runtime_state of repetition_guard in klantantwoorden.",
      ],
    },
  };

  return [
    "RUNTIME CONTEXT VOOR EMMA",
    "Gebruik deze context als hoogste gespreksspecifieke input naast de system prompt.",
    "De context is feitelijk; herhaal hem niet letterlijk naar de klant.",
    "",
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
    "Je bent een strikte CRM-extractor voor een WhatsApp salesgesprek.",
    "Je taak is NIET om te antwoorden op de gebruiker.",
    "Je analyseert alleen het nieuwste gebruikersbericht in de context van bestaande CRM-data.",
    "Je geeft uitsluitend geldige JSON terug.",
    "Gebruik Nederlands.",
    "Vul alleen een veld als het nieuwste gebruikersbericht echt nieuwe of duidelijk concretere informatie toevoegt.",
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

/* ---------------------------- REPLY VALIDATION ---------------------------- */

function isLikelyRepetitiveReply(reply, recentMessages) {
  const normalizedReply = normalizeComparableText(reply);
  if (!normalizedReply) return false;

  const recentEmmaMessages = getLastEmmaMessages(recentMessages, 3);

  return recentEmmaMessages.some((oldReply) => {
    const normalizedOld = normalizeComparableText(oldReply);
    if (!normalizedOld) return false;

    if (normalizedReply === normalizedOld) return true;

    const shorter =
      normalizedReply.length < normalizedOld.length
        ? normalizedReply
        : normalizedOld;

    const longer =
      normalizedReply.length >= normalizedOld.length
        ? normalizedReply
        : normalizedOld;

    return shorter.length > 80 && longer.includes(shorter);
  });
}

function violatesHardRepetitionRules(reply, recentMessages) {
  const text = cleanText(reply);

  const testimonialAlreadySent = hasLinkBeenSent(
    recentMessages,
    "youtube.com/@Nutrition-Works"
  );

  const checkoutAlreadySent = hasCheckoutLinkBeenSent(recentMessages);
  const priceAlreadyMentioned = hasPriceBeenMentioned(recentMessages);

  if (testimonialAlreadySent && /youtube\.com\/@Nutrition-Works/i.test(text)) {
    return "testimonial_repeated";
  }

  if (checkoutAlreadySent && /bestellen-nl-control-1x|bestellen-be-control-1x/i.test(text)) {
    return "checkout_link_repeated";
  }

  if (priceAlreadyMentioned && /€\s*123|123\s*euro|programma kost/i.test(text)) {
    return "price_repeated";
  }

  return "";
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

  console.log("CHAT HIT");
  console.log(
    JSON.stringify(
      {
        user_id: normalizedUserId,
        message_preview: clamp(originalMessage, 120),
        customer_status: normalizedCustomerStatus,
        current_phase: normalizedCurrentPhase,
        has_goal: Boolean(normalizedGoal),
        has_objections: Boolean(normalizedObjections),
        has_last_summary: Boolean(normalizedLastSummary),
        debounce_ms: DEBOUNCE_MS,
      },
      null,
      2
    )
  );

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
    console.log(
      JSON.stringify(
        {
          event: "DEBOUNCE_SKIPPED_OLDER_MESSAGE",
          user_id: normalizedUserId,
          original_message_preview: clamp(originalMessage, 120),
        },
        null,
        2
      )
    );

    return res.json(
      buildResponse({
        send_reply: false,
        reply: "",
        goal_update: "",
        objections_update: "",
        last_summary_update: "",
      })
    );
  }

  const normalizedMessage = cleanText(debounced.message || originalMessage);

  const normalizedRecentMessages = sanitizeAndPrepareRecentMessages(
    recent_messages,
    normalizedMessage
  );

  console.log(
    JSON.stringify(
      {
        event: "DEBOUNCE_PROCESSING_LATEST_MESSAGE",
        user_id: normalizedUserId,
        final_message_preview: clamp(normalizedMessage, 300),
        recent_messages_count: normalizedRecentMessages.length,
        has_whatsapp_group_link: hasWhatsappGroupLinkBeenSent(normalizedRecentMessages),
        last_roles: normalizedRecentMessages.slice(-5).map((m) => m.role),
      },
      null,
      2
    )
  );

  if (!normalizedMessage) {
    return res.json(
      buildResponse({
        send_reply: false,
        reply: "",
        goal_update: "",
        objections_update: "",
        last_summary_update: "",
      })
    );
  }

  const coachSourceResponse = handleCoachSourceCodeIfNeeded(normalizedMessage);

  if (coachSourceResponse) {
    console.log("COACH SOURCE CODE HANDLED SERVER-SIDE");
    return res.json(coachSourceResponse);
  }

  const orderControlResponse = handleOrderControlIfNeeded(
    normalizedMessage,
    normalizedRecentMessages
  );

  if (orderControlResponse) {
    console.log("ORDER CONTROL HANDLED SERVER-SIDE");
    return res.json(orderControlResponse);
  }

  if (!agentId) {
    console.error("CONFIG ERROR: ELEVENLABS_AGENT_ID ontbreekt");
    return res.json(buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }

  try {
    const alreadyValidated = isCustomerStatusValidated(
      normalizedCustomerStatus,
      normalizedRecentMessages
    );

    const [replyResult, extractionResult] = await Promise.allSettled([
      getElevenReply({
        userId: normalizedUserId,
        message: normalizedMessage,
        customerStatus: alreadyValidated
          ? "customer"
          : normalizedCustomerStatus,
        currentPhase: alreadyValidated
          ? "coaching"
          : normalizedCurrentPhase,
        goal: normalizedGoal,
        objections: normalizedObjections,
        lastSummary: normalizedLastSummary,
        recentMessages: normalizedRecentMessages,
        agentId,
      }),
      getStructuredUpdates({
        message: normalizedMessage,
        customerStatus: alreadyValidated
          ? "customer"
          : normalizedCustomerStatus,
        currentPhase: alreadyValidated
          ? "coaching"
          : normalizedCurrentPhase,
        currentGoal: normalizedGoal,
        currentObjections: normalizedObjections,
        currentLastSummary: normalizedLastSummary,
        recentMessages: normalizedRecentMessages,
      }),
    ]);

    let reply =
      replyResult.status === "fulfilled"
        ? cleanReplyText(replyResult.value) || FALLBACK_REPLY
        : FALLBACK_REPLY;

    if (replyResult.status === "rejected") {
      console.error("ELEVENLABS PROMISE ERROR:", replyResult.reason);
    }

    const repeatedReason = violatesHardRepetitionRules(
      reply,
      normalizedRecentMessages
    );

    if (repeatedReason) {
      console.error("REPETITION GUARD HIT:", repeatedReason);
      reply =
        "Ik pak je laatste bericht erbij en ga daarop verder. Kun je kort bevestigen wat je nu het liefst wil weten of regelen?";
    }

    if (isLikelyRepetitiveReply(reply, normalizedRecentMessages)) {
      console.error("REPETITION GUARD HIT: reply lijkt op eerdere Emma-reactie");
      reply =
        "Ik ga hier niet opnieuw hetzelfde over uitleggen. Kun je kort aangeven waar je nu precies op wilt reageren?";
    }

    reply = cleanReplyText(reply);

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
